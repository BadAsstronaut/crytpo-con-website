'use strict';

require('dotenv').config();

const aws = require('aws-sdk');
const crypto = require('crypto');
const requester = require('request-promise-native');
const stripe = require('stripe')(process.env.STRIPE_AUTH);
const sendGrid = require('@sendgrid/mail');

const dynamoClient = new aws.DynamoDB.DocumentClient();

const {
    ADMIN_EMAIL,
    DYNAMO_TABLE,
    GLOBEE_AUTH,
    GLOBEE_CURRENCY,
    GLOBEE_SUCCESS_URL,
    GLOBEE_URL,
    GLOBEE_WEBHOOK_URL,
    SENDGRID_API_KEY,
} = process.env;

sendGrid.setApiKey(SENDGRID_API_KEY);

const sortKeys = {
    prefixes: {
        transaction: 'transaction_',
        inventoryHold: 'inventoryHold_',
    },
    attendees: 'attendees',
    inventory: 'inventory',
    price: 'price',
};

const appErrorResponse = {
    statusCode: 500,
    headers: {
        'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ message: 'Internal application error' }),
};

const badRequestResponse = (message) => ({
    statusCode: 400,
    headers: {
        'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ message: message || 'Bad Request' }),
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
            callback_data: `${payment.partitionKey}|${payment.numTickets}`,
            success_url: GLOBEE_SUCCESS_URL,
            ipn_url: GLOBEE_WEBHOOK_URL,
        }),
    };

    return requester(reqOptions)
        .then(response => {
            const parsed = JSON.parse(response);
            return {
                id: parsed.data.id,
                status: parsed.data.status,
                total: parsed.data.total,
                currency: parsed.data.currency,
                customer: parsed.data.customer,
                redirectUrl: parsed.data.redirect_url,
                expiresAt: parsed.data.expires_at,
            };
        })
        .catch(err => { throw err; });
};

const createStripePayment = (payment, token) => {
    console.log(`Creating stripe payment with payment info:\n${JSON.stringify(payment, undefined, 2)}`);
    console.log(`Token: ${JSON.stringify(token, undefined, 2)}`);

    return stripe.charges.create({
        amount: payment.total * 100,
        currency: 'usd',
        source: token.id,
    })
        .then(charge => {
            console.log(`Successfully charged Stripe:\n${JSON.stringify(charge, undefined, 2)}`);
            return charge;
        })
        .catch(err => {
            console.log(`Error processing stripe transaction: ${err.message}`);
            throw err;
        });
};

// Dynamo-mite! (aka dynamo queries)
const queryPartition = (pk) => {
    const params = {
        TableName: DYNAMO_TABLE,
        KeyConditionExpression: 'PartitionKey = :partitionKey',
        ExpressionAttributeValues: { ':partitionKey': pk },
    };

    return dynamoClient.query(params).promise()
        .catch(err => { throw err; });
};

const querySortKey = (sk) => {
    const params = {
        TableName: DYNAMO_TABLE,
        IndexName: "SortKeyIndex",
        KeyConditionExpression: 'SortKey = :sortKey',
        ExpressionAttributeValues: { ':sortKey': sk },
    };

    return dynamoClient.query(params).promise()
        .catch(err => { throw err; });
};

const putStripeTransaction = (stripeResponse, tierInfo, attendees, paymentInfo) => {
    const attendeeRecords = createAttendeeData(tierInfo.inventory.current, tierInfo.partitionKey, attendees);
    const stripePaymentInfo = {
        id: stripeResponse.id,
        transactionType: 'stripe',
        status: 'paid',
        total: (stripeResponse.amount / 100),
        currency: stripeResponse.currency,
        customer: {
            email: paymentInfo.email,
            name: paymentInfo.name,
        },
        expiresAt: null,
    };

    const transactionObject = createTransactionObject(tierInfo, stripePaymentInfo, attendeeRecords, paymentInfo.allowEmail);

    console.log(`Transaction: ${JSON.stringify(transactionObject, undefined, 2)}`);
    const batchParams = {
        RequestItems: {
            [DYNAMO_TABLE]: [{ PutRequest: { Item: transactionObject } }]
        }
    };

    return Promise.all([
        dynamoClient.batchWrite(batchParams).promise(),
        updateAttendees(tierInfo.partitionKey, attendeeRecords),
    ])
        .then(() => {
            return attendeeUpdateEmails(transactionObject);
        })
        .catch(err => {
            console.error(`Error saving to dynamo: ${err.message}`);
            throw err;
        });
}

const putGlobeeTransaction = (globeeResponse, tierInfo, attendees, paymentInfo) => {
    // create attendee records here and add to attendees on success! :D
    const attendeeRecords = createAttendeeData(tierInfo.inventory.current, tierInfo.partitionKey, attendees);

    console.log(JSON.stringify(globeeResponse));

    const transactionObject = createTransactionObject(
        tierInfo,
        Object.assign(
            globeeResponse,
            { transactionType: 'globee' }),
        attendeeRecords,
        paymentInfo.allowEmail,
    );

    const inventoryHolds = attendeeRecords
        .map((i, idx) => {
            const ttl = Math.floor(Date.parse(globeeResponse.expiresAt) / 1000);
            return {
                PartitionKey: tierInfo.partitionKey,
                SortKey: `${sortKeys.prefixes.inventoryHold}${globeeResponse.id}_${idx}`,
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

const updateTransaction = async (updateData) => {
    const {
        id,
        status,
        callback_data: ticketInfo,
    } = updateData;

    const { partitionKey, numTickets } = parsePartitionTickets(ticketInfo, 10);
    const tierData = await queryPartition(partitionKey);

    const transaction = extractElementBySortKey(tierData.Items, `${sortKeys.prefixes.transaction}${id}`);
    transaction.Status.push({ status, date: isoDate() });

    console.log(`transaction: ${JSON.stringify(transaction)}`);

    const deleteRequests = [...Array(numTickets).keys()].map((i, idx) => ({
        DeleteRequest: {
            Key: {
                PartitionKey: partitionKey,
                SortKey: `${sortKeys.prefixes.inventoryHold}${id}_${idx}`
            },
        }
    }));

    const putRequests = [{ PutRequest: { Item: transaction } }];

    // only delete placeholder items on 'paid' status
    const requestItems = status === 'paid'
        ? putRequests.concat(deleteRequests)
        : putRequests;

    const batchParams = {
        RequestItems: {
            [DYNAMO_TABLE]: requestItems,
        }
    };

    console.log(`Batch params: ${JSON.stringify(batchParams)}`);

    const promises = [
        dynamoClient.batchWrite(batchParams).promise(),
    ];

    if (status === 'paid') {
        promises.push(updateAttendees(partitionKey, transaction.Attendees));
        promises.push(attendeeUpdateEmails(transaction));
    }

    return Promise.all(promises);
};

const updateAttendees = (partitionKey, attendees) => {
    const updateParams = {
        TableName: DYNAMO_TABLE,
        Key: { PartitionKey: partitionKey, SortKey: sortKeys.attendees },
        UpdateExpression: `SET AttendeeList = list_append(AttendeeList, :newAttendees)`,
        ExpressionAttributeValues: {
            ':newAttendees': attendees,
        },
    };

    console.log(`updateParams: ${JSON.stringify(updateParams)}`);
    return dynamoClient.update(updateParams).promise()
        .catch(err => {
            console.error(`Error saving attendees: ${err.message}`);
            throw err;
        });
};

// Sendgrid functions
const attendeeUpdateEmails = (transaction) => {
    return Promise.all([
        updateAttendeesToAdmin(),
        notifyPayorConfirmation(transaction),
    ]);
};

const updateAttendeesToAdmin = () => {
    return querySortKey('attendees')
        .then(attendeesToTier)
        .then(attendeesByTier => {
            return sendGrid.send({
                to: ADMIN_EMAIL,
                from: 'konferenco@monerokon.com',
                subject: `Upated attendee list ${formattedDateTime()}`,
                html: adminUpdate(attendeesByTier),
            });
        })
};

const notifyPayorConfirmation = (transaction) => {
    return sendGrid.send({
        to: transaction.Customer.email,
        from: 'konferenco@monerokon.com',
        subject: 'Thank you for purchasing MoneroKon tickets',
        html: attendeeConfirmation(transaction),
    });
};

// Email templates
const adminUpdate = (attendeesByTier) => {
    return `
<p>
Current attendee list:
</p>

<table width="600px">
<tbody>
${tierHtmlRows(attendeesByTier).join('')}
</tbody>
</table>
`;
};

const attendeeConfirmation = (transaction) => (`
<p>
Dear ${transaction.Customer.name},
</p>

<p>
Thank you for your purchase. If you need further assitance please contact us at <a href="mailto: ${ADMIN_EMAIL}">${ADMIN_EMAIL}</a>.
</p>

<p>
Order Date: ${formattedDateTime()}
</p>
<p>
Ticket Tier: ${transaction.PartitionKey.split('_')[1]}
</p>
<p>
Quantity: ${transaction.Attendees.length}
</p>
<p>
Amount: ${transaction.Amount}
</p>

<h4>Ticket details:</h4>
<table width="600px">
<tbody>
<tr>
  <td align="left">Attendee</td>
  <td align="left">Institution</td>
  <td align="left">Confirmation Code</td>
<tr>
${transaction.Attendees.map(attendeeHtmlRow).join('')}
</tbody>
</table>
`);

const tierHtmlRows = (attendeesByTier) => {
    return Object.keys(attendeesByTier)
        .map(tier => (`<tr>
<td colspan="3">${tier}</td>
</tr>${attendeesByTier[tier].map(attendeeHtmlRow).join('')}`));
}

const attendeeHtmlRow = (attendee) => (`<tr>
<td>${attendee.name}</td>
<td>${attendee.institution}</td>
<td>${attendee.identifier}</td>
</tr>`);

// utility functions
const attendeesToTier = (attendeeData) => {
    return attendeeData.Items.reduce((result, item) => {
        const tier = item.PartitionKey.split('_')[1];
        result[tier] = item.AttendeeList;
        return result;
    }, {});
};

const remapTier = tierData => {
    const partitionKey = tierData.Items[0].PartitionKey;
    const tier = partitionKey.split('_')[1]
    const inventory = {
        initial: extractElementBySortKey(tierData.Items, sortKeys.inventory).Total,
        current: remainingInventory(tierData.Items),
    };

    const price = getCurrentPrice(tierData.Items);
    const attendees = extractElementBySortKey(tierData.Items, sortKeys.attendees);

    return {
        partitionKey,
        tier,
        inventory,
        price,
        attendees,
    };
};

const parsePartitionTickets = (numTicketsString) => {
    const parts = numTicketsString.split('|');

    return {
        partitionKey: parts[0],
        numTickets: parseInt(parts[1], 10),
    };
};

const createHash = (raw) => {
    return crypto
        .createHash('sha256')
        .update(raw)
        .digest('hex');
};

const createTransactionObject = (tierInfo, paymentInfo, attendeeRecords, allowEmail) => ({
    PartitionKey: tierInfo.partitionKey,
    SortKey: `${sortKeys.prefixes.transaction}${paymentInfo.id}`,
    PaymentType: paymentInfo.transactionType,
    Status: [{ status: paymentInfo.status, date: isoDate() }],
    Amount: paymentInfo.total,
    Currency: paymentInfo.currency,
    Customer: Object.assign({}, paymentInfo.customer, { allowEmail }),
    ExpiresAt: paymentInfo.expiresAt || null,
    Attendees: attendeeRecords,
});


const createAttendeeData = (inventory, partitionKey, attendees) => (attendees.map((attendee, idx) => {
    // attendee hash = H(ticket-tier + name + institution + ticket number)
    return {
        name: attendee.name,
        institution: attendee.institution || null,
        identifier: createHash(`${partitionKey}${attendee.name}${attendee.institution}${inventory - idx}`),
    };
}));

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

    if (attendees && attendees.AttendeeList && Array.isArray(attendees.AttendeeList)) {
        allocated += attendees.AttendeeList.length;
    }

    allocated += tierItems
        .filter(i => i.SortKey.startsWith('inventoryHold'))
        .length;

    return startingInventory - allocated;
};

const getCurrentPrice = (tierItems) => {
    const priceItem = tierItems.find(i => i.SortKey === 'price');
    const price = Math.min(
        ...priceItem.PricingMap.ByDate
            .filter(i => (Date.parse(i.EndDate) >= Date.now()))
            .map(i => i.Price)
    );

    return price;
};

const isoDate = () => {
    return new Date().toISOString();
};

const formattedDateTime = (date = new Date()) => (
    `${date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} ${date.toLocaleTimeString('en-US')}`
);

const paymentDetails = (tierItems, name, email, numTickets, allowEmail) => {
    const partitionKey = tierItems[0].PartitionKey;
    const ticketPrice = getCurrentPrice(tierItems);
    const total = ticketPrice * numTickets;

    return {
        total,
        name,
        email,
        numTickets,
        partitionKey,
        allowEmail,
    };
};


// Exported lambda functions
module.exports.globeePayment = async (e) => {
    const {
        purchaserName,
        purchaserEmail,
        tier,
        attendees,
        allowEmail,
    } = JSON.parse(e.body);

    if (tier === 'student' && !purchaserEmail.endsWith('.edu')) {
        return badRequestResponse(`Requires .edu email to purchase student tickets`);
    }

    let rawTierData;
    try {
        rawTierData = await queryPartition(`ticketTier_${tier}`);
    } catch (err) {
        console.error(`Error retrieving tier data: ${err.message}`, err);
        return appErrorResponse;
    }

    if (!(rawTierData.Items && rawTierData.Items.length)) {
        return badRequestResponse(`No ticket information was found for ${tier}`);
    }

    if (!(remainingInventory(rawTierData.Items) >= attendees.length)) {
        return badRequestResponse(`Insufficient inventory for ${tier} available`);
    }

    if (attendees.length > 15) {
        return badRequestResponse('Only 15 tickets may be purchased per transaction.');
    }

    const tierInfo = remapTier(rawTierData);

    const paymentInfo = paymentDetails(
        rawTierData.Items,
        purchaserName,
        purchaserEmail,
        attendees.length,
        allowEmail,
    );

    let globeeResponse;
    try {
        globeeResponse = await createGlobeePayment(paymentInfo);
    } catch (err) {
        console.error(`Error creating Globee request: ${err.message}`, err);
        return appErrorResponse;
    }

    return putGlobeeTransaction(globeeResponse, tierInfo, attendees, paymentInfo)
        .then(() => ({
            statusCode: 201,
            headers: {
                'Access-Control-Allow-Origin': '*',
            },
            body: JSON.stringify({
                redirectUrl: globeeResponse.redirectUrl,
            })
        }))
        .catch(err => {
            console.log(`Error saving transaction: ${err.message}`);
        });
};

module.exports.globeePaymentWebhook = async e => {
    const request = JSON.parse(e.body);
    return updateTransaction(request)
        .then(() => ({ statusCode: 200 }))
        .catch(err => {
            console.log(`Error occurred during instant payment notification callback: ${err.message}`);
            return {
                statusCode: 500,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                },
            };
        });
};

module.exports.stripePayment = async e => {
    const {
        purchaserName,
        purchaserEmail,
        tier,
        attendees,
        allowEmail,
        token,
    } = JSON.parse(e.body);

    if (tier === 'student' && !purchaserEmail.endsWith('.edu')) {
        return badRequestResponse(`Requires .edu email to purchase student tickets`);
    }

    let rawTierData;
    try {
        rawTierData = await queryPartition(`ticketTier_${tier}`);
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
        attendees.length,
        allowEmail,
    );

    return createStripePayment(paymentInfo, token)
        .then(charge => {
            return putStripeTransaction(charge, tierInfo, attendees, paymentInfo);
        })
        .then(() => {
            return {
                statusCode: 201,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                },
                body: JSON.stringify({
                    redirectUrl: GLOBEE_SUCCESS_URL,
                }),
            };
        })
        .catch(err => {
            return {
                statusCode: 500,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                },
            };
        });
};

module.exports.ticketPricesAndInventory = async e => {
    const tierMap = {
        0: 'student',
        1: 'general',
        2: 'platinum',
    };

    return Promise.all([
        queryPartition('ticketTier_student'),
        queryPartition('ticketTier_general'),
        queryPartition('ticketTier_platinum'),
    ])
        .then(partitionResults => {
            return partitionResults
                .map((part, idx) => {
                    const result = {
                        tier: tierMap[idx],
                        inventory: remainingInventory(part.Items),
                        price: getCurrentPrice(part.Items),
                    };

                    console.log(`TicketInfo map result: ${JSON.stringify(result, undefined, 2)}`);

                    return result;
                })
                .reduce((obj, el) => {
                    console.log(`TicketInfo reduce:\nAccumulator: ${JSON.stringify(obj, undefined, 2)}\nElement: ${JSON.stringify(el, undefined, 2)}`)
                    obj[el.tier] = { inventory: el.inventory, price: el.price };
                    return obj;
                }, {});
        })
        .then(tierData => {
            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                },
                body: JSON.stringify(tierData),
            };
        })
        .catch(err => {
            console.log(`Error occurred during ticke prices GET`);
            return {
                statusCode: 500,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                },
            };
        });
};
