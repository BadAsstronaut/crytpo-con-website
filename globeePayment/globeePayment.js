'use strict';

module.exports.globeePayment = (e, ctx, cb) => {
    console.log(JSON.stringify(e), JSON.stringify(ctx));

    cb({
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
