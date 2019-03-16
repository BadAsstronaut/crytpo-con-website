const aws = require('aws-sdk');
const RequestItems = require('./CryptoCon.json');

const dynamo = new aws.DynamoDB.DocumentClient();

const responseStatus = {
    success: 'SUCCESS',
    failure: 'FAILED',
};

const generateResponse = (e, ctx, Status) => ({
    Status,
    Reason: `See cloudwatch log stream ${ctx.log_stream_name}`,
    PhysicalResourceId: ctx.log_stream_name,
    StackId: e.StackId,
    RequestId: e.RequestId,
    LogicalResourceId: e.LogicalResourceId,
});

module.exports.handler = async (e, ctx) => {
    const params = {
        RequestItems,
    };

    return dynamo.batchWrite(params).promise()
        .then(data => {
            console.log(`Successfully seeded the CryptoCon table with ${data}`);
            return generateResponse(e, ctx, responseStatus.success);
        })
        .catch(err => {
            console.error(err);
            return generateResponse(e, ctx, responseStatus.failure);
        });
};