FROM python:3.12-alpine

RUN apk add dumb-init

RUN pip3 install smbprotocol

RUN mkdir /source

COPY filereacher.py /source

COPY web /source/web

WORKDIR /source

ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["dumb-init", "/source/filereacher.py"]
