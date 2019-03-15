const aws = require('aws-sdk');
const RequestItems = require('./CryptoCon.json');

const dynamo = new aws.DynamoDB.DocumentClient();

module.exports.handler = async () => {
    const params = {
        RequestItems,
    };

    return dynamo.batchItems(params).promise()
        .then(data => {
            console.log("Successfully seeded the CryptoCon table");
        })
        .catch(err => {
            console.error(err);
        });
};