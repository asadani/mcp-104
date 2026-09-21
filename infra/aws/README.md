# Optional AWS deployment

The sample uses App Runner for the HTTP MCP/UI container, RDS PostgreSQL for
durable state, Secrets Manager for credentials, and CloudWatch for logs. The
checked-in template creates only the App Runner service and its two roles;
the database and the secrets are passed in by ARN, so the course cannot
accidentally create something expensive.

**Status: written, not deployed.** There was no Docker daemon and no
CloudFormation linter where this was written, so the `Dockerfile` has not been
built and `template.yaml` has not been linted or deployed. Run `cfn-lint` and a
first deploy in a scratch account before trusting either.

What the application now enforces, and tests:

- With `NODE_ENV=production` it refuses to start unless `DATABASE_URL`,
  `TOKEN_SECRET` and `PUBLIC_ORIGIN` are set, instead of quietly using a local
  file database and a random per-process signing key.
- `GET /healthz` answers 200 after a `SELECT 1`, or 503 if the database cannot
  be reached. The container and the App Runner health check use it.
- Demo members and tasks are not seeded in production.

Steps:

1. Build and push the image: `docker build -t teamspace .` then push it to ECR.
2. Create two secrets: a `postgres://` connection string, and a token
   verification secret of at least 32 characters. Replace the local teaching
   `Identity` provider with your OAuth/OIDC provider adapter. The `/dev/token`,
   `/authorize` and `/token` routes are not mounted under `NODE_ENV=production`
   and must never become an Internet-facing login shortcut. If either secret
   uses a customer-managed KMS key, add narrowly scoped `kms:Decrypt` permission
   for that key to the instance role before deployment.
3. Provision the members table for real users. Nothing seeds it in production.
4. Deploy `template.yaml`, passing `ImageUri`, `DatabaseSecretArn`,
   `TokenSecretArn` and `PublicOrigin`.
5. Put WAF or API Gateway in front when the service is public.
6. Migrations run when the process starts and every statement is safe to rerun.
   For a fleet, run them once as a separate step before shifting traffic.
7. Background jobs are processed by a worker inside each instance. Leases make
   that safe with several instances. To run workers separately, set
   `WORKER=off` on the service and run `npm run worker` (it needs the shared
   PostgreSQL).
8. Verify `/healthz`, `/mcp` (401 with a challenge without a token), the OAuth
   metadata, tenant isolation, shutdown and job redelivery.

Delete the CloudFormation stack, ECR images and any separately provisioned data
services after the lab. Cloud resources incur charges.
