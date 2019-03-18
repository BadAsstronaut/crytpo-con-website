'use strict';

require('dotenv').config();
const crypto = require('crypto');
const aws = require('aws-sdk');
const requester = require('request-promise-native');
const uuid = require('uuid/v4');

const dynamoClient = new aws.DynamoDB.DocumentClient();

const {
    DYNAMO_TABLE,
    GLOBEE_AUTH,
    GLOBEE_CURRENCY,
    GLOBEE_SUCCESS_URL,
    GLOBEE_URL,
    GLOBEE_WEBHOOK_URL,
} = process.env;

const appErrorResponse = {
    statusCode: 500,
    body: 'Internal application error',
};

const badRequestResponse = (message) => ({
    statusCode: 400,
    body: message || 'Bad Request',
});

// External APIs
const createGlobeePayment = (payment) => {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-AUTH-KEY': GLOBEE_AUTH,
    };

    const reqOptions = {
        method: 'POST',
        uri: `${GLOBEE_URL}payment-request`,
        headers,
        body: JSON.stringify({
            total: payment.total,
            currency: GLOBEE_CURRENCY || 'USD',
            custom_store_reference: 'Monero Crypto Conference',
            customer: {
                name: payment.name,
                email: payment.email,
            },
            success_url: GLOBEE_SUCCESS_URL,
            ipn_url: GLOBEE_WEBHOOK_URL,
        }),
    };

    return requester(reqOptions)
        .then(response => {
            const parsed = JSON.parse(response);
            return {
                id: parsed.data.id,
                customer: parsed.data.customer,
                redirectUrl: parsed.data.redirect_url,
                expiresAt: parsed.data.expires_at,
            };
        })
        .catch(err => { throw err; });
};


// Dynamo-mite! (aka dynamo queries)
const queryTier = (tier) => {
    const params = {
        TableName: DYNAMO_TABLE,
        KeyConditionExpression: 'PartitionKey = :partitionKey',
        ExpressionAttributeValues: { ':partitionKey': `ticketTier_${tier}` },
    };

    return dynamoClient.query(params).promise()
        .catch(err => { throw err; });
};

const putTransactionPlaceholder = (globeeResponse, tierInfo, attendees) => {
    // create attendee records here and add to attendees on success! :D
    const mapAttendeeFn = createAttendee(tierInfo.inventory.current, tierInfo.partitionKey);
    const transactionObject = {
        PartitionKey: tierInfo.partitionKey,
        SortKey: `transactions${globeeResponse.id}`,
        PaymentType: 'globee',
        Status: globeeResponse.status,
        Amount: globeeResponse.total,
        Currency: globeeResponse.currency,
        Customer: globeeResponse.customer,
        ExpiresAt: globeeResponse.expiresAt,
        Attendees: attendees.map(mapAttendeeFn),
    };

    const inventoryHolds = attendees
        .map(() => {
            const ttl = Math.floor(Date.parse(globeeResponse.expiresAt) / 1000);
            return {
                PartitionKey: tierInfo.partitionKey,
                SortKey: `inventoryHold${uuid()}`,
                TTL: ttl,
            };
        });

    const putRequests = inventoryHolds
        .map(i => ({ PutRequest: { Item: i } }))
        .concat([{ PutRequest: { Item: transactionObject } }]);

    const params = {
        RequestItems: {
            [DYNAMO_TABLE]: putRequests,
        },
    };

    console.log(JSON.stringify(params));

    return dynamoClient.batchWrite(params).promise()
        .then(() => {
            console.log(`Globee transaction created with payment ID ${globeeResponse.id}`);
        })
        .catch(err => {
            console.error(JSON.stringify(err));
            throw err;
        });
};

// utility functions
const remapTier = tierData => {
    const partitionKey = tierData.Items[0].PartitionKey;
    const tier = partitionKey.split('_')[1]
    const inventory = {
        initial: extractElementBySortKey(tierData.Items, 'inventory').Total,
        current: remainingInventory(tierData.Items),
    };

    const price = getCurrentPrice(tierData.Items);
    const transactions = extractElementBySortKey(tierData.Items, 'transactions');
    const attendees = extractElementBySortKey(tierData.Items, 'attendees');

    return {
        partitionKey,
        tier,
        inventory,
        price,
        transactions,
        attendees,
    };
};

const createHash = (raw) => {
    return crypto
        .createHash('sha256')
        .update(raw)
        .digest('hex');
};

const createAttendee = (inventory, partitionKey) => (attendee, idx) => {
    // attendee hash = H(ticket-tier + name + institution + ticket number)
    return {
        name: attendee.name,
        institution: attendee.institution,
        identifier: createHash(`${partitionKey}${attendee.name}${attendee.institution}${inventory - idx}`),
    };
};

const extractElementBySortKey = (items, keyVal) => {
    return items
        .find(i => i.SortKey === keyVal);
};

const remainingInventory = (tierItems) => {
    // TODO: Refactor to use reformatted document
    let allocated = 0;
    const startingInventory = (tierItems
        .find(i => i.SortKey === 'inventory'))
        .Total;
    const attendees = tierItems.find(i => i.SortKey === 'attendees');

    if (attendees && Array.isArray(attendees)) {
        allocated += attendees.length;
    }

    allocated += tierItems
        .filter(i => i.SortKey.startsWith('inventoryHold'))
        .length;

    return startingInventory - allocated;
};

const getCurrentPrice = (tierItems) => {
    const priceItem = tierItems.find(i => i.SortKey === 'price');
    const price = Math.min(...priceItem.PricingMap.ByDate
        .filter(i => (Date.parse(i.EndDate) >= Date.now()))
        .map(i => i.Price));

    return price;
};

const paymentDetails = (tierItems, name, email, numTickets) => {
    const ticketPrice = getCurrentPrice(tierItems);
    const total = ticketPrice * numTickets;

    return {
        total,
        name,
        email,
    };
};

module.exports.globeePayment = async (e) => {
    /**
     * Input schema:
     * - purchaserName
     * - purchaserEmail
     * - tier general|student|platinum
     * - attendees: [{
     *      name,
     *      institution?,
     *    }]
     */

    const {
        purchaserName,
        purchaserEmail,
        tier,
        attendees,
    } = JSON.parse(e.body);

    if (tier === 'student' && !purchaserEmail.endsWith('.edu')) {
        return badRequestResponse(`Requires .edu email to purchase student tickets`);
    }

    let rawTierData;
    try {
        rawTierData = await queryTier(tier);
    } catch (err) {
        console.error(`Error retrieving tier data: ${err.message}`, err);
        return appErrorResponse;
    }

    if (!(rawTierData.Items && rawTierData.Items.length)) {
        return badRequestResponse(`No ticket information was found for ${tier}`);
    }

    if (!(remainingInventory(rawTierData.Items) >= attendees.length)) {
        return badRequestResponse(`No inventory for ${tier} available`);
    }

    const tierInfo = remapTier(rawTierData);

    const paymentInfo = paymentDetails(
        rawTierData.Items,
        purchaserName,
        purchaserEmail,
        attendees.length
    );

    let globeeResponse;
    try {
        globeeResponse = await createGlobeePayment(paymentInfo);
    } catch (err) {
        console.error(`Error creating Globee request: ${err.message}`, err);
        return appErrorResponse;
    }

    let transactionInfo;
    try {
        transactionInfo = await putTransactionPlaceholder(globeeResponse, tierInfo, attendees)
    } catch (err) {
        return appErrorResponse;
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            redirectUrl: globeeResponse.redirectUrl,
        }),
    };
};

module.exports.globeePaymentWebhook = async e => {
    const data = JSON.parse(e.body);
    console.log(e.body);
    // finalize inventory and create attendee
    return { statusCode: 200 };
};

module.exports.globeePendingTimeout = async e => {
    // https://aws.amazon.com/blogs/database/automatically-archive-items-to-s3-using-dynamodb-time-to-live-with-aws-lambda-and-amazon-kinesis-firehose/
};

