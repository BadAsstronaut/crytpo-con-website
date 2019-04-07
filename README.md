# CRYPTO-CON-WEBSITE

This project integrates Stripe and Globee via a cloudformation backend employing serverless/lambdas/dynamo db, etc. Email notifications are provided by SendGrid in order to get around Amazon's overly lengthy verification process.

The use case is a ticketing platform for a conference. 

### .env file

`ticketPayments/index.js` relies on a `.env` file containing the following environment variables:

```
ADMIN_EMAIL=test@example.com
DYNAMO_TABLE=<DynamoDB Table Name>
GLOBEE_AUTH=<Globee Authroization API key>
GLOBEE_CURRENCY=USD
GLOBEE_SUCCESS_URL=<redirect URL after payments>
GLOBEE_URL=<Globee API target>
GLOBEE_WEBHOOK_URL=<Instant Payment Notification callback>
SENDGRID_API_KEY=<...>
STRIPE_AUTH=<Stripe secret key>
```