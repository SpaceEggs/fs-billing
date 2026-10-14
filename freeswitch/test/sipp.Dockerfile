FROM debian:bookworm
# bookworm 的 SIPp 包名是 sip-tester。
RUN apt-get update && apt-get install -y --no-install-recommends sip-tester=1:3.6.1-1+b2 sox \
    && mkdir -p /media \
    && sox -n -r 8000 -c 1 -e mu-law /media/silence.wav trim 0 1 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["sipp"]
