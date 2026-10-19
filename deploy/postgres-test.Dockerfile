FROM postgres:17-alpine

COPY test/fixtures/postgres-test.crt /etc/postgresql/test-server.crt
COPY test/fixtures/postgres-test.key /etc/postgresql/test-server.key
RUN chown postgres:postgres /etc/postgresql/test-server.crt /etc/postgresql/test-server.key \
    && chmod 644 /etc/postgresql/test-server.crt \
    && chmod 600 /etc/postgresql/test-server.key

CMD ["postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/etc/postgresql/test-server.crt", "-c", "ssl_key_file=/etc/postgresql/test-server.key"]
