'use strict';

require('dotenv').config();

const aws = require('aws-sdk');
const requester = require('request-promise-native');
const uuid = require('uuid/v4');

const dynamoClient = new aws.DynamoDB.DocumentClient();

const {
    GLOBEE_URL,
    GLOBEE_AUTH,
    GLOBEE_CURRENCY,
    GLOBEE_SUCCESS_URL,
} = process.env;

const createGlobeePayment = (paymentDetails) => {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-AUTH-KEY': GLOBEE_AUTH,
    };

    const reqOptions = {
        method: 'POST',
        uri: `https://${GLOBEE_URL}/payment-api/v1/payment-request`,
        headers,
        json: true,
        body: {
            total: paymentDetails.total,
            currency: GLOBEE_CURRENCY || 'USD',
            custom_store_reference: 'Monero Crypto Conference',
            customer: {
                name: paymentDetails.name,
                email: paymentDetails.email,
            },
            success_url: GLOBEE_SUCCESS_URL,
            ipn_url: GLOBEE_WEBHOOK_URL,
        },
    };

    return requester(reqOptions)
        .then(data => ({
            id: data.id,
            customer: data.customer,
            redirectUrl: data.redirect_url,
            expiresAt: data.expires_at,
        }))
        .catch(err => { throw err; });
};

const createTransaction = (transactionData) => {
    const params = {
        table: 'CryptoCon',
        item: {

        },
    };
};

module.exports.globeePayment = async (e) => {
    const reqData = JSON.parse(e.body);

    // check requested ticket # against inventory
    // create request to globee
    // ==> FAIL: Send response to client to try again
    // create inventory placeholder as expiration date string (from response)
    // 

    /**
     * Input schema:
     * - purchaserName
     * - purchaserEmail
     * - tier
     * - [{
     *      name,
     *      institution?,
     *    }]
     */

    const attendeeParams = {
        Item: {
            PartitionKey: uuid(),
            TicketTier: reqData.tier,
            Name: reqData.name,
            Email: reqData.email,
            PurchaseVerification: null,
        },
        TableName: 'CryptoCon',
    };

    const purchaseParams = {

    };


    // Create an attendee
    // .edu email address for student pricing!
    // Create a purchase
    // initial ticket availablity: 50 student, 200 general, 50 platinum
    // attendee hash = H(ticket-tier + name + institution + ticket number)
    return {
        statusCode: 201,
        headers: {
            'x-custom-test': 'Test header'
        },
        body: JSON.stringify({
            status: 'good',
            redirect_url: 'http://redirect.to.here',
            success_url: 'http://success.to.here',
        }),
    };
};

module.exports.globeeInstantPaymentNotification = async e => {
    const data = JSON.parse(e.body);

    // finalize inventory and create attendee
    return { statusCode: 200 };
};
