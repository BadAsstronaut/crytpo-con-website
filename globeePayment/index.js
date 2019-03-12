'use strict';

const aws = require('aws-sdk');
const requester = require('request-promise-native');


module.exports.globeePayment = (e, ctx, cb) => {
    const dynamoClient = new aws.DynamoDB.DocumentClient();
    const reqData = JSON.parse(e.body);

    cb(null, {
        statusCode: 201,
        headers: {
            'x-custom-test': 'Test header'
        },
        body: JSON.stringify({
            status: 'good',
            redirect_url: 'http://redirect.to.here',
            success_url: 'http://success.to.here',
        }),
    });
};
