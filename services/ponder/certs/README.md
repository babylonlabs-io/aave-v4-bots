# RDS certificate bundle

`rds-global-bundle.pem` is Amazon's public certificate bundle for RDS in every commercial region
(108 root certificates), used to verify the database server certificate when `DATABASE_URL`
carries `sslmode=verify-full&sslrootcert=<path>` (see `src/dbAuth.ts`). Node's default trust store
does not contain the RDS certificate authorities, so the file ships inside the image:
`docker/ponder.Dockerfile` copies `services/ponder/` whole, and in the container it lives at
`/app/services/ponder/certs/rds-global-bundle.pem`.

Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem (documented under
"Certificate bundles by AWS Region" in
https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).

sha256 of the committed file, fetched 2026-09-07:

```
e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3  rds-global-bundle.pem
```

Refresh when AWS publishes new root CAs (they announce it; the `rds-ca-*-g1` CAs in use are valid
to 2061): download the same URL over TLS, check `grep -c 'BEGIN CERTIFICATE'` grows and the file
still parses (`openssl crl2pkcs7 -nocrl -certfile rds-global-bundle.pem | openssl pkcs7
-print_certs -noout`), and update the checksum above in the same commit. Never fetch it at image
build time; a build must not depend on a network download it cannot verify.
