# syntax=docker/dockerfile:1
FROM debian:bookworm
COPY freeswitch/install/install.sh /usr/local/sbin/install-freeswitch
RUN --mount=type=secret,id=signalwire_token,required=true \
    bash /usr/local/sbin/install-freeswitch && rm -rf /var/lib/apt/lists/*
COPY freeswitch/docker/entrypoint.sh /usr/local/bin/fs-integration-entrypoint
ENTRYPOINT ["/bin/bash", "/usr/local/bin/fs-integration-entrypoint"]
