#!/usr/bin/env python3

import base64
import http.server
import json
import mimetypes
import os
import socketserver
import threading
import urllib.parse

try:
	import smbclient
except ImportError:
	pass


class Storage(object):
	@staticmethod
	def sortedList(dirs, files):
		return {
				'dirs': sorted(dirs, key=lambda x: x.lower()),
				'files': sorted(files, key=lambda x: x['name'].lower())
			}

	@staticmethod
	def ensureNormalized(path):
		if '..' in path:
			raise ValueError('unexpected relative path')

	def list(self, path):
		dirs = []
		files = []
		for entry in self.scandir(path):
			if entry.is_dir():
				dirs.append(entry.name)
			elif entry.is_file():
				stat = entry.stat()
				files.append({
						'name': entry.name,
						'size': stat.st_size,
						'mtime': stat.st_mtime
					})

		return self.sortedList(dirs, files)

	def rmdirRecursive(self, path):
		delete = []
		remaining = [path]
		while remaining:
			path = remaining.pop()
			for entry in self.scandir(path):
				entryPath = os.path.join(path, entry.name)
				if entry.is_dir():
					remaining.append(entryPath)
				else:
					self.delete(entryPath)

			delete.append(path)

		for path in reversed(delete):
			self.rmdir(path)


class LocalStorage(Storage):
	def __init__(self):
		self.baseDir = os.environ['FR_LOCAL_BASE']
		self.name = os.path.basename(self.baseDir)

	def join(self, path):
		path = os.path.join(self.baseDir,
			os.path.relpath(path, '/') if path else '')

		self.ensureNormalized(path)
		if not os.path.normpath(path).startswith(self.baseDir):
			raise ValueError('outside of base dir')
		return path

	def scandir(self, path):
		return os.scandir(self.join(path))

	def mkdir(self, path):
		return os.mkdir(self.join(path))

	def rmdir(self, path):
		return os.rmdir(self.join(path))

	def open(self, path, mode):
		return open(self.join(path), mode)

	def rename(self, source, dest):
		return os.rename(self.join(source), self.join(dest))

	def delete(self, path):
		return os.remove(self.join(path))


class SambaStorage(Storage):
	def __init__(self):
		self.host = os.environ['FR_SAMBA_HOST']
		self.share = os.environ['FR_SAMBA_SHARE']
		self.name = self.share

		smbclient.ClientConfig(username=os.environ['FR_SAMBA_USER'],
			password=os.environ['FR_SAMBA_PASSWORD'])

	def join(self, path):
		path = f'//{self.host}/{self.share}/{path}'
		self.ensureNormalized(path)
		return path

	def scandir(self, path):
		return smbclient.scandir(self.join(path))

	def mkdir(self, path):
		return smbclient.mkdir(self.join(path))

	def rmdir(self, path):
		return smbclient.rmdir(self.join(path))

	def open(self, path, mode):
		return smbclient.open_file(self.join(path), mode)

	def rename(self, source, dest):
		return smbclient.rename(self.join(source), self.join(dest))

	def delete(self, path):
		return smbclient.remove(self.join(path))


def chunkGenerator(input, size):
	offset = 0

	with input:
		def writer(data, writeOffset):
			nonlocal offset, size, input

			if not data:
				size = 0
				return

			if offset != writeOffset:
				size = 0
				raise ValueError(
					f'unexpected offset {offset} vs. {writeOffset}')

			input.write(data)
			offset += len(data)

		while offset < size:
			yield writer


class Handler(http.server.BaseHTTPRequestHandler):
	chunkSize = 1024 * 1024

	def sendEmptyResponse(self, code, status=None):
		self.send_response(code, status)
		self.end_headers()

	def parsePath(self):
		_, _, path, query, _ = urllib.parse.urlsplit(self.path)
		self.fields = urllib.parse.parse_qs(query) if query else {}
		return path

	def decodeField(self, name):
		return base64.b64decode(self.fields[name][0]).decode() \
				if name in self.fields else ''

	def intField(self, name):
		return int(self.fields[name][0])

	def sendFile(self, path, input):
			self.protocol_version = 'HTTP/1.1'
			self.send_response(200)
			self.send_header('Content-Type', mimetypes.guess_type(path)[0])
			self.send_header('Transfer-Encoding', 'chunked')
			self.end_headers()

			while True:
				chunk = input.read(self.chunkSize)
				if not chunk:
					break

				self.wfile.write(f'{len(chunk):X}\r\n'.encode())
				self.wfile.write(chunk)
				self.wfile.write(b'\r\n')
				self.wfile.flush()

			self.wfile.write(b'0\r\n\r\n')

	def sendJSON(self, data, status=200):
		self.send_response(status)
		self.send_header('Content-Type', 'application/json')
		self.end_headers()
		self.write(json.dumps(
				json.loads(json.dumps(data), parse_constant=lambda x: None),
				indent='\t'))

	def sendError(self, code, text):
		self.sendJSON({ 'error': text }, code)

	def write(self, text):
		if text is not None:
			self.wfile.write(text.encode('utf-8'))

	def readInput(self):
		return self.rfile.read(int(self.headers['Content-Length']))

	def do_GET(self):
		path = self.parsePath()

		try:
			if path in ('/list', '/download'):
				entry = self.decodeField('path')
				if path == '/list':
					return self.sendJSON(self.server.storage.list(entry))
				else:
					with self.server.storage.open(entry, 'rb') as input:
						return self.sendFile(entry, input)

			if path == '/info':
				return self.sendJSON({ 'name': self.server.storage.name })

		except Exception as exception:
			return self.sendError(500, str(exception))

		if path == '/':
			path = '/index.html'

		filePath = os.path.join('web', path[1:])
		if os.path.exists(filePath):
			with open(filePath, 'rb') as input:
				return self.sendFile(filePath, input)

		self.sendError(404, 'not found')

	def do_POST(self):
		path = self.parsePath()

		try:
			if path == '/upload':
				entry = self.decodeField('path')
				cookie = self.server.startUpload(entry, self.intField('size'))
				return self.sendJSON({ 'cookie': cookie })

			if path == '/mkdir':
				self.server.storage.mkdir(self.decodeField('path'))
				return self.sendJSON({})

		except Exception as exception:
			return self.sendError(500, str(exception))

		self.sendError(404, 'not found')

	def do_PATCH(self):
		path = self.parsePath()

		try:
			if path == '/upload':
				self.server.writeChunk(self.intField('cookie'),
					self.intField('offset'), self.readInput())
				return self.sendJSON({})

		except Exception as exception:
			return self.sendError(500, str(exception))

		self.sendError(404, 'not found')

	def do_PUT(self):
		path = self.parsePath()

		try:
			if path == '/upload':
				self.server.completeUpload(self.intField('cookie'))
				return self.sendJSON({})

			if path == '/rename':
				self.server.storage.rename(self.decodeField('path'),
					self.decodeField('to'))
				return self.sendJSON({})

		except Exception as exception:
			return self.sendError(500, str(exception))

		self.sendError(404, 'not found')

	def do_DELETE(self):
		path = self.parsePath()

		try:
			if path == '/delete':
				self.server.storage.delete(self.decodeField('path'))
				return self.sendJSON({})

			if path == '/rmdir':
				self.server.storage.rmdirRecursive(self.decodeField('path'))
				return self.sendJSON({})

		except Exception as exception:
			return self.sendError(500, str(exception))

		self.sendError(404, 'not found')


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
	def __init__(self):
		backend = os.environ.get('FR_BACKEND')
		if not backend:
			raise ValueError('no storage backend specified')
		elif backend == 'local':
			self.storage = LocalStorage()
		elif backend == 'samba':
			self.storage = SambaStorage()

		self.uploads = {}
		self.lock = threading.Lock()
		self.cookie = 0
		http.server.HTTPServer.__init__(self,
			(os.environ.get('FR_ADDRESS', '0.0.0.0'),
				int(os.environ.get('FR_PORT', '5210'))), Handler)

	def nextCookie(self):
		with self.lock:
			self.cookie += 1
			return self.cookie

	def startUpload(self, path, size):
		cookie = self.nextCookie()
		self.uploads[cookie] \
			= chunkGenerator(self.storage.open(path, 'wb'), size)
		return cookie

	def writeChunk(self, cookie, offset, data):
		writer = next(self.uploads[cookie])
		try:
			writer(data, offset)
		except Exception as exception:
			del self.uploads[cookie]
			raise

	def completeUpload(self, cookie):
		try:
			writer = next(self.uploads[cookie])
			raise ValueError('incomplete upload')
		except StopIteration:
			pass
		finally:
			del self.uploads[cookie]


Server().serve_forever()
