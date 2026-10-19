# v0.9 configuration and migration

## OAuth-only identities

A client can omit `tokenEnv` when it has an explicit nonempty `subject`. Enable the deployment's JWT or introspection profile to authenticate it. An identity without a key can never authenticate through the built-in API-key provider; its subject is not a secret or a replacement key. Existing key-based identities remain compatible. The console supports leaving the key reference empty and requires a subject in that case.

```json
{"id":"report-agent","subject":"trusted-workload-subject","oauthClientId":"report-client","allow":["reports__read"],"roles":["reader"]}
```

Gateway OAuth mode is still a deployment setting. There is no hosted login, automatic issuer discovery or simultaneous multi-provider configuration. User consent, PKCE and refresh-token lifecycle remain identity-provider/client responsibilities.

## JWT key retrieval

Remote JWKS retrieval keeps the pinned HTTPS endpoint and three-second timeout, rejects redirects, and accepts a UTF-8 JSON object of at most 65,536 decoded response bytes with 1–64 keys. Both application/json and application/jwk-set+json are accepted. The size bound covers chunked bodies. jose retains caching, concurrent-fetch coalescing, and unknown-key cooldown; there is no local reimplementation of signature verification.

Large issuer key sets exceeding this profile now fail closed. Check issuer compatibility before deployment. The bound is an engineering resource limit, not an MCP/OAuth universal limit. Key-cache freshness is not instant revocation. DPoP and mTLS-bound tokens are still rejected because this release does not implement proof verification.

## Upstream OAuth response profile

Expired cached exchanges are coalesced while the cache entry remains resident. Cache size remains bounded and separate processes retain separate caches. Responses must be JSON objects no larger than 16 KiB, with a safe bearer token of at most 8,192 characters and a positive finite expires_in. A returned scope must contain every requested scope; omitted scope retains the OAuth meaning of unchanged requested scope.

RFC 8693 exchanges must return issued_token_type equal to urn:ietf:params:oauth:token-type:access_token. Missing or alternate types are rejected. This follows the required field in [RFC 8693 section 2.2.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-2.2.1), with a deliberately restricted bearer-access-token profile. Interactive refresh flows and arbitrary token formats are not implemented. Token endpoint URLs now share the security endpoint validator: HTTPS, or explicitly enabled loopback HTTP, without URL credentials, queries or fragments.

## Route target availability

Set a target's `enabled` to false to exclude it from built-in weighted, sticky, rendezvous and priority alias selection. Omission means enabled. If every target is disabled, the alias is unavailable. The console exposes this per-target control. Continuations recheck target availability and role/tenant/client selectors.

This stops new alias selection when the published configuration is observed. It does not cancel an already running backend operation, implement health checks, replay failed calls, or revoke a separately allowed physical tool name. To revoke direct access, change the corresponding permissions. A custom trusted Router owns its own selection semantics and must implement availability itself.

## Rolling deployment and rollback

Upgrade serving replicas before publishing OAuth-only clients or enabled fields: older schemas reject these documents. For rollback, first publish a reviewed configuration compatible with the older image (supply valid key references where needed and remove enabled fields), then roll back. No database migration is introduced. Do not silently replace absent credentials with dummy secrets. The local demo retains its original credential references and database revision.

## Remaining work

This is a tested hardening checkpoint, not completion of the requested programme. The source ledger records 25/200 articles/chapters, 40 selected-body paper inspections and 5/40 review cycles. Additional issuer/workload mechanisms, proof-bound tokens, trusted backend-resource authorization, shared health routing, resumability/ingress soak tests and outcome reconciliation require further work. ReBAC remains an optional OpenFGA intersection with local grants, not a claim of backend record ownership.
