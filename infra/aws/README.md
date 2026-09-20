# Optional AWS deployment

The sample uses App Runner for the HTTP MCP/UI container, RDS PostgreSQL for
durable state, ElastiCache-compatible Redis for distributed rate limits, SQS
plus a worker for jobs, Secrets Manager for credentials, and CloudWatch for
logs/metrics. The checked-in template creates only the App Runner service and
its role; managed data services are referenced by secret/environment values so
the course cannot accidentally create an expensive database.

1. Build and push the image to ECR.
2. Replace the local teaching `Identity` provider with your OAuth/OIDC provider
   adapter. The `/dev/token` route is disabled under `NODE_ENV=production` and
   must never become an Internet-facing login shortcut.
3. Store `DATABASE_URL`, signing/verification configuration, and optional
   `REDIS_URL` in Secrets Manager. Use a distinct public origin.
4. Deploy `template.yaml`, passing the image URI and secret ARN.
5. Put WAF/API Gateway or another edge control in front when public.
6. Run migrations as a one-off job before shifting traffic.
7. Verify `/mcp`, OAuth metadata, tenant isolation, shutdown and job redelivery.

Delete the CloudFormation stack, ECR images and any separately provisioned data
services after the lab. Cloud resources incur charges.
