# 07 · Auth brokerage is harder than one API key

Model gateways can often map one credential to interchangeable text endpoints.
Tool gateways must preserve each user's delegated access to each product. Store
refresh tokens in a vault, bind access tokens to audience, minimize scopes,
separate tenants and log consent changes. Downstream calls carry the original
subject; gateway service identity alone is insufficient for user data.
