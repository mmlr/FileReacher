# FileReacher
A simple web interface to local and SMB storage which features file browsing and
management, drag&drop uploads and chunked down and uploads to allow for
arbitrary file sizes.

## Configuration
All configuration takes place with environment variables. The following global
options exist:

* `FR_BACKEND`: Selects the storage backend to use, either 'local' or 'samba'.
* `FR_ADDRESS`: The listen address for the server, defaults to '0.0.0.0'.
* `FR_PORT`: The listen port, defaults to 5210.

## Local Backend
The local backend serves files and directories from the local filesystem. The
following configuration options exist for the local backend:

* `FR_LOCAL_BASE`: The base directory where to operate in.

## Samba Backend
The Samba backend allows to operate directly on an SMB share. The following
configuration options exist for the Samba backend:

* `FR_SAMBA_HOST`: The host of the share.
* `FR_SAMBA_SHARE`: The name of the share.
* `FR_SAMBA_USER`: The username to log in as.
* `FR_SAMBA_PASSWORD`: The passwort to use for the log in.

## Deployment
A demo docker-compose file is provided with a container for both the local and
the Samba backend. For the latter, a Samba share is provided by another
container.
