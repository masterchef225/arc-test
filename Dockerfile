FROM alpine:3.20
RUN apk add --no-cache curl
RUN echo "hello from arc-built image" > /hello.txt
CMD ["cat", "/hello.txt"]
