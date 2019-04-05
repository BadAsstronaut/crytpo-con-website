const urlParser = require('url').parse;
const https = require('https');
const aws = require('aws-sdk');
const RequestItems = require('./CryptoCon.json');

const dynamo = new aws.DynamoDB();

const responseStatus = {
    success: 'SUCCESS',
    failure: 'FAILED',
};

const generateResponse = (e, ctx, Status, cb) => {
    const responseBody = JSON.stringify({
        Status,
        Reason: `See cloudwatch log stream ${ctx.logStreamName}`,
        PhysicalResourceId: ctx.logStreamName,
        StackId: e.StackId,
        RequestId: e.RequestId,
        LogicalResourceId: e.LogicalResourceId,
    });

    const url = urlParser(e.ResponseURL);
    const httpOpts = {
        hostname: url.hostname,
        port: 443,
        path: url.path,
        method: 'PUT',
        headers: {
            'content-type': '',
            'content-length': responseBody.length,
        },
    };

    const req = https.request(httpOpts, () => {
        cb();
    });

    req.on(
        'error',
        err => {
            console.error(
                `Error sending response for custom resource: ${JSON.stringify(err)}`
            )
            cb(err.message);
        });

    req.write(responseBody);
    req.end();
};

module.exports.handler = (e, ctx, cb) => {
    const params = {
        RequestItems,
    };

    dynamo.batchWriteItem(params).promise()
        .then(data => {
            console.log(`Successfully seeded the CryptoCon table with ${JSON.stringify(data, undefined, 2)}`);
            return generateResponse(e, ctx, responseStatus.success, cb);
        })
        .catch(err => {
            console.error(err);
            return generateResponse(e, ctx, responseStatus.failure, cb);
        });
};