'use strict';


let info;
let currentPath = [''];
let listing;
let navigation;
let uploadsPending = 0;
let uploadQueue = Promise.resolve();
let uploadStatus;

const chunkSize = 1024 * 1024;


function error(error)
{
	alert(`${error}`);
}


function check(result)
{
	let failed = result.status != 200;
	return result.json().then((result) => {
			if (result.error)
				throw new Error(result.error);
			if (failed)
				throw new Error('API call failed');

			return result;
		});
}


function checkedRefresh(result)
{
	return check(result).then(() => navigate());
}


function encodePath(name, limit)
{
	return btoa(join(name, limit));
}


function pathArg(name, limit)
{
	return `path=${encodePath(name, limit)}`;
}


function createEntry(name, type)
{
	let element = document.createElement('div');
	element.classList.add('entry');
	element.classList.add(type);

	let group = document.createElement('a');
	group.classList.add('title');
	element.appendChild(group);

	let icon = document.createElement('img');
	icon.src = `${type}.svg`;
	icon.alt = type;
	group.appendChild(icon);

	let label = document.createElement('span');
	label.textContent = name;
	group.appendChild(label);

	let actions = document.createElement('div');
	actions.classList.add('actions');

	let renameAction = document.createElement('img');
	renameAction.classList.add('rename');
	renameAction.src = 'rename.svg';
	renameAction.alt = 'rename';
	renameAction.title = 'Rename';
	renameAction.onclick= () => {
		let to = prompt(`Rename ${name} to?`);
		if (!to)
			return;

		fetch(`rename?${pathArg(name)}&to=${encodePath(to)}`, {
				method: 'PUT',
				cache: 'no-cache'
			}).then(checkedRefresh).catch(error);
	};

	let deleteAction = document.createElement('img');
	deleteAction.classList.add('delete');
	deleteAction.src = 'delete.svg';
	deleteAction.alt = 'delete';
	deleteAction.title = 'Delete';

	actions.appendChild(renameAction);
	actions.appendChild(deleteAction);
	element.appendChild(actions);
	return element;
}


function formatSize(size)
{
	let unit = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	while (size > 1024) {
		size /= 1024;
		unit.shift();
	}

	return `${size.toFixed(2)}\u00a0${unit[0]}`;
}


function createFile(name, size)
{
	let path = pathArg(name);

	let element = createEntry(name, 'file');
	element.classList.add('file');

	let title = element.querySelector('.title');
	title.href = `download?${path}`;
	title.download = name;

	let sizeLabel = document.createElement('span');
	sizeLabel.classList.add('size');
	sizeLabel.textContent = formatSize(size);
	sizeLabel.title = `${size} Bytes`;

	let deleteAction = element.querySelector('.delete');
	deleteAction.onclick = () => {
		if (!confirm(`Delete ${name}?`))
			return;

		fetch(`delete?${path}`, {
				method: 'DELETE',
				cache: 'no-cache'
			}).then(checkedRefresh).catch(error);
	};

	title.insertAdjacentElement('afterEnd', sizeLabel);
	return element;
}


function createDir(name)
{
	let element = createEntry(name, 'dir');
	element.classList.add('dir');

	let title = element.querySelector('.title');
	let path = name == '..' ? pathArg(undefined, -1) : pathArg(name);
	title.href = `?${path}`;
	title.onclick = (event) => {
		navigate(name, true);
		event.preventDefault();
	};

	let deleteAction = element.querySelector('.delete');
	if (name == '..') {
		let actions = element.querySelector('.actions');
		actions.parentElement.removeChild(actions);
	} else {
		deleteAction.onclick = () => {
			if (!confirm(`Delete ${name} and its contents?`))
				return;

			fetch(`rmdir?${path}`, {
					method: 'DELETE',
					cache: 'no-cache'
				}).then(checkedRefresh).catch(error);
		};
	}

	return element;
}


function join(name, limit)
{
	let path = currentPath;
	if (limit !== undefined)
		path = currentPath.slice(0, limit);
	if (name)
		path = path.concat(name);

	return path.join('/');
}


function navigate(name, addToHistory)
{
	if (name == '..')
		currentPath.pop();
	else if (name !== undefined)
		currentPath.push(name)

	let elements = currentPath.map((path, index) => {
			let element = document.createElement('a');
			element.textContent = path ? path : info.name;

			let encoded = btoa(join(undefined, index + 1));
			element.href = `?path=${encoded}`;
			element.onclick = (event) => {
				restorePath(encoded, true);
				event.preventDefault();
			};
			return element;
		});

	if (addToHistory)
		history.pushState({}, currentPath.slice(-1), `?${pathArg()}`);

	navigation.replaceChildren(...elements);
	document.title
		= `FileReacher - ${info.name} - ${currentPath.concat(['']).join('/')}`;
	return list(addToHistory);
}


function list(clear)
{
	if (clear)
		listing.replaceChildren();

	return fetch(`list?${pathArg()}`).then(check)
		.then((result) => {
			let elements = [];
			if (currentPath.length > 1)
				elements.push(createDir('..'));

			result.dirs.map((name) => elements.push(createDir(name)));
			result.files.map(
				(file) => elements.push(createFile(file.name, file.size)));

			listing.replaceChildren(...elements);
		}, error);
}


function uploadStarted(result, name)
{
	uploadProgressed(0);
	uploadStatus.querySelector('.name').textContent = name;
	uploadStatus.classList.add('show');
	return result;
}


function uploadProgressed(percentage)
{
	uploadStatus.querySelector('.progress').style.width = `${percentage}%`;
}


function uploadCompleted()
{
	uploadProgressed(100);
	updatePendingUploads(-1);
}


function updatePendingUploads(count)
{
	uploadsPending += count;
	uploadStatus.querySelector('.pending').textContent = uploadsPending;
}


function hideUploadStatus()
{
	uploadStatus.classList.remove('show');
	navigate();
}


function startUpload(file, path)
{
	return fetch(`upload?${path}&size=${file.size}`, {
			method: 'POST',
			cache: 'no-cache'
		})
		.then(check)
		.then((result) => uploadStarted(result, file.name))
		.then((result) => uploadChunk(file, result.cookie, 0))
		.catch(error);
}


function uploadChunk(file, cookie, offset)
{
	if (offset >= file.size)
		return completeUpload(cookie);

	let slice = file.slice(offset, offset + chunkSize);
	return fetch(`upload?cookie=${cookie}&offset=${offset}`, {
			method: 'PATCH',
			cache: 'no-cache',
			body: slice
		})
		.then(check)
		.then(() => uploadProgressed(offset / file.size * 100))
		.then(() => uploadChunk(file, cookie, offset + chunkSize));
}


function completeUpload(cookie)
{
	return fetch(`upload?cookie=${cookie}`, {
			method: 'PUT',
			cache: 'no-cache'
		})
		.then(check)
		.then(uploadCompleted);
}


function drop(event)
{
	glow(event, false);
	event.preventDefault();

	uploadQueue = Array.from(event.dataTransfer.items).reduce((queue, item) => {
			if (item.kind != 'file')
				return;

			updatePendingUploads(1);
			let file = item.getAsFile();
			let path = pathArg(file.name);
			return queue.then(() => startUpload(file, path));
		}, uploadQueue).then(hideUploadStatus);
}


function drag(event)
{
	let files = [...event.dataTransfer.items]
		.filter((item) => item.kind == 'file');
	if (!files.length)
		return;

	glow(event, true);
	event.preventDefault();
}


function glow(event, on)
{
	event.currentTarget.classList.toggle('drag', on);
}


function restorePath(encoded, addToHistory)
{
	currentPath = atob(encoded).split('/');
	return navigate(undefined, addToHistory);
}


function popstate()
{
	let url = new URL(document.location);
	return restorePath(url.searchParams.get('path') || '');
}


function mkdir()
{
	let name = prompt('Directory name');
	if (!name)
		return;

	return fetch(`mkdir?${pathArg(name)}`, {
			method: 'POST',
			cache: 'no-cache'
		})
		.then(checkedRefresh).catch(error);
}


function upload()
{
	let input = document.createElement('input');
	input.type = 'file';
	input.multiple = 'multiple';
	input.onchange = () => {
		uploadQueue = Array.from(input.files).reduce((queue, file) => {
				updatePendingUploads(1);
				let path = pathArg(file.name);
				return queue.then(() => startUpload(file, path));
			}, uploadQueue).then(hideUploadStatus);
	};
	input.click();
}


function init()
{
	listing = document.querySelector('#listing');
	navigation = document.querySelector('#path');
	uploadStatus = document.querySelector('#uploadStatus');

	document.querySelector('#mkdir').onclick = mkdir;
	document.querySelector('#upload').onclick = upload;

	let target = document.documentElement;
	target.ondrop = drop;
	target.ondragover = drag;
	target.ondragleave = (event) => glow(event, false);

	window.onpopstate = popstate;
	fetch('info').then((result) => result.json())
		.then((result) => info = result).then(popstate);
}


window.onload = init;
