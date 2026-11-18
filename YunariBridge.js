/*
 * Yunari RGB bridge — SignalRGB network plugin.
 *
 * Yunari owns the real Kraken Z (1e71:3008): the LCD on HID interface 1 + bulk
 * interface 0, the LEDs and the pump/fan reports. SignalRGB must never open that
 * device, so this plugin only speaks HTTP (control/discovery) and UDP (colour
 * frames) to loopback:
 *
 *   GET  http://127.0.0.1:5227/api/devices              -> hub + lighting devices
 *   UDP  127.0.0.1:<lighting.udpPort>  (default 7788)   -> YRGB frames
 *
 * Frame (little-endian):
 *   0..3  magic "YRGB" (59 52 47 42)
 *   4     version 1
 *   5     device index (order in the descriptor's devices array)
 *   6..7  LED count, uint16 LE
 *   8..   3xN RGB triples, channel order
 *
 * Layout model: one SignalRGB subdevice per lighting device by default, so each
 * device is independently placeable on the Layouts canvas AND carries its real
 * geometry (ring perimeter / strip rows) from the descriptor. Channels are the
 * fallback model because SignalRGB channels are geometry-less LED chains — see
 * README.md and tools/yunari_bridge_selfcheck.mjs.
 *
 * No HID, USB, serial or vendor matching lives here on purpose.
 */
/* global device, service, udp, LightingMode, forcedColor, shutdownColor, devices, layoutModel, apiHost, apiPort */

export function Name() { return "Yunari"; }
export function Version() { return "1.0.0"; }
export function Type() { return "network"; }
export function Publisher() { return "Huy Nguyen"; }
// Icon embedded as a data: URI: the plugin sandbox cannot address its own
// folder, and a file:// path would not survive being shipped. Regenerate with
// tools/embed_image_urls.py after changing the icon.
export function ImageUrl() {
	return "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj4KPHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI1MTIiIHJ4PSI5NiIgZmlsbD0iIzExMTMxOCIvPgo8cGF0aCBkPSJNMTE4IDEyOGg3Nmw2MiA4OCA2Mi04OGg3NmwtMTAwIDE0MnYxMTRoLTc2VjI3MEwxMTggMTI4eiIgZmlsbD0iI0YyRjRGOCIvPgo8cGF0aCBkPSJNMjU2IDIxNmwtMzggNTRoNzZ6IiBmaWxsPSIjN0REM0ZDIi8+CjxjaXJjbGUgY3g9IjE1NiIgY3k9IjE1NiIgcj0iMTEiIGZpbGw9IiMxMTEzMTgiLz48Y2lyY2xlIGN4PSIzNTYiIGN5PSIxNTYiIHI9IjExIiBmaWxsPSIjMTExMzE4Ii8+Cjwvc3ZnPg==";
}
export function DeviceType() { return "lightingcontroller"; }
export function SubdeviceController() { return true; }
export function Size() { return [1, 1]; }
export function DefaultPosition() { return [1, 1]; }
export function DefaultScale() { return 1.0; }

const LOOPBACK = "127.0.0.1";
const API_PORT = 5227; // default; apiPort overrides it
const DEFAULT_UDP_PORT = 7788;
const DEFAULT_DEVICES = "kraken-z:40:rings:3:3:3";
const REFRESH_MS = 15000;
const MAX_HZ = 30;
const MIN_INTERVAL_MS = 1000 / MAX_HZ;
const STABLE_ID = "yunari";
const MAGIC = [0x59, 0x52, 0x47, 0x42]; // "YRGB"

export function ControllableParameters() {
	return [
		{ property: "apiHost", group: "device", label: "Yunari API host", description: "Leave blank for 127.0.0.1.", type: "textfield", default: "127.0.0.1" },
		{ property: "apiPort", group: "device", label: "Yunari API port", description: "HTTP port Yunari listens on.", type: "number", min: "1", max: "65535", step: "1", default: "5227" },
		{ property: "devices", group: "device", label: "Fallback devices (id:leds:shape:width:height[:count];...)", description: "Used until Yunari answers GET /api/devices, and whenever it is unreachable. Default: the Kraken's three 8-LED fan rings (rings 3x3, count 3) inside its 40-LED channel. Shapes: strip, ring, rings. Semicolon-separated.", type: "textfield", filter: "^[A-Za-z0-9_.:; ,-]*$", default: DEFAULT_DEVICES },
		{ property: "layoutModel", group: "device", label: "Layout model", description: "Subdevices (default): one independently placeable subdevice per lighting device with the descriptor geometry. Channels: the L10-style fallback for SignalRGB builds where subdevices do not enumerate; channels are generic chains the user maps.", type: "combobox", values: ["Subdevices", "Channels"], default: "Subdevices" },
		{ property: "LightingMode", group: "lighting", label: "Lighting Mode", description: "Canvas pulls colours from the effect; Forced uses one colour on every LED.", type: "combobox", values: ["Canvas", "Forced"], default: "Canvas" },
		{ property: "forcedColor", group: "lighting", label: "Forced Color", description: "Colour used when Lighting Mode is Forced.", min: "0", max: "360", type: "color", default: "#009bde" },
		{ property: "shutdownColor", group: "lighting", label: "Shutdown Color", description: "Colour written when SignalRGB shuts down (suspend always uses black).", min: "0", max: "360", type: "color", default: "#000000" },
	];
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function number(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function clampByte(value) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return 0;
	return n < 0 ? 0 : (n > 255 ? 255 : n);
}

function hexToRgb(hex) {
	const text = String(hex || "#000000").replace("#", "");
	if (text.length !== 6) return [0, 0, 0];
	return [parseInt(text.slice(0, 2), 16) || 0, parseInt(text.slice(2, 4), 16) || 0, parseInt(text.slice(4, 6), 16) || 0];
}

function solidRgb(color, count) {
	const out = new Array(count * 3);
	for (let i = 0; i < count; i++) {
		out[i * 3] = color[0];
		out[i * 3 + 1] = color[1];
		out[i * 3 + 2] = color[2];
	}
	return out;
}

function prettify(id) {
	return String(id || "Device").replace(/[-_]+/g, " ").replace(/\b[a-z]/g, c => c.toUpperCase());
}

let subdevicesFailed = false;

function currentModel() {
	if (subdevicesFailed) return "Channels";
	return String(typeof layoutModel !== "undefined" ? layoutModel : "Subdevices") === "Channels" ? "Channels" : "Subdevices";
}

function log(message) {
	try {
		if (typeof device !== "undefined" && device && typeof device.log === "function") {
			device.log("[YunariBridge] " + message);
		}
	} catch (e) {
		// logging must never break a render
	}
}

// Discovery runs in its own sandbox on 2.5.86; service.log is the only log that
// exists there (and it is not persisted to SignalRGB_*.log on that build).
function dlog(message) {
	log(message);
	try {
		if (typeof service !== "undefined" && service && typeof service.log === "function") {
			service.log("[YunariBridge] " + message);
		}
	} catch (e) {
		// discovery log unavailable
	}
}

// ---------------------------------------------------------------------------
// descriptor -> lighting devices
// ---------------------------------------------------------------------------

// Fallback syntax: id:leds:shape:width:height[;...]. One implicit channel per
// entry. Used before the HTTP descriptor answers and when Yunari is offline.
function parseFallback(raw) {
	const text = String(raw || "").trim() || DEFAULT_DEVICES;
	const out = [];
	text.split(";").map(part => part.trim()).filter(Boolean).forEach((part, index) => {
		const bits = part.split(":");
		const id = String(bits[0] || `device-${index + 1}`).trim();
		const leds = Math.max(1, Math.floor(number(bits[1], 40)));
		const requested = String(bits[2] || "ring").toLowerCase();
		const shape = requested === "strip" || requested === "rings" ? requested : "ring";
		const defaultSide = shape === "ring" || shape === "rings" ? Math.ceil((leds + 4) / 4) : leds;
		const width = Math.max(1, Math.floor(number(bits[3], defaultSide)));
		const height = Math.max(1, Math.floor(number(bits[4], shape === "ring" || shape === "rings" ? defaultSide : 1)));
		const count = Math.max(1, Math.floor(number(bits[5], 0)) || 1);
		const name = prettify(id);
		out.push({
			index,
			id,
			name,
			ledCount: leds,
			udpPort: DEFAULT_UDP_PORT,
			channels: [{ name, leds }],
			layout: { shape, width, height, count },
			subdeviceId: `yunari:${id}`,
		});
	});
	return out;
}

function devicesFromDescriptor(json) {
	const list = json && Array.isArray(json.devices) ? json.devices : [];
	const out = [];
	list.forEach((raw, index) => {
		if (!raw || typeof raw !== "object") return;
		const lighting = raw.lighting && typeof raw.lighting === "object" ? raw.lighting : {};
		const rawChannels = Array.isArray(lighting.channels) ? lighting.channels : [];
		const channels = rawChannels.map((entry, i) => ({
			name: String((entry && entry.name) || `Channel ${i + 1}`),
			leds: Math.max(0, Math.floor(number(entry && entry.leds, 0))),
		})).filter(entry => entry.leds > 0);
		let ledCount = Math.max(0, Math.floor(number(lighting.ledCount, 0)));
		if (!ledCount) ledCount = channels.reduce((sum, entry) => sum + entry.leds, 0);
		if (!ledCount) return; // no lighting -> no subdevice and no frame
		if (!channels.length) channels.push({ name: String(raw.name || raw.id || `Device ${index + 1}`), leds: ledCount });
		const layout = lighting.layout && typeof lighting.layout === "object" ? lighting.layout : {};
		const id = String(raw.id || `device-${index}`);
		out.push({
			index,
			id,
			name: String(raw.name || raw.id || `Device ${index + 1}`),
			ledCount,
			udpPort: Math.max(1, Math.floor(number(lighting.udpPort, DEFAULT_UDP_PORT))),
			channels,
			layout: {
				shape: String(layout.shape || "strip"),
				width: Math.max(1, Math.floor(number(layout.width, ledCount))),
				height: Math.max(1, Math.floor(number(layout.height, 1))),
				count: Math.max(1, Math.floor(number(layout.count, 1))),
			},
			subdeviceId: `yunari:${id}`,
		});
	});
	return out;
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

// Rectangle ring in the RML pattern: left side bottom->top, top left->right,
// right side top->bottom, bottom right->left. For 40 LEDs this is 11x11
// (2*11 + 2*9 = 40); a 4x4 ring is only 12 LEDs.
function ringPositions(width, height) {
	const pts = [];
	for (let k = 0; k < height; k++) pts.push([0, height - 1 - k]);
	for (let x = 1; x <= width - 2; x++) pts.push([x, 0]);
	for (let y = 0; y < height; y++) pts.push([width - 1, y]);
	for (let x = width - 2; x >= 1; x--) pts.push([x, height - 1]);
	return pts;
}

function layoutFor(entry) {
	const count = Math.max(1, Math.floor(entry.ledCount) || 1);
	const layout = entry.layout || {};
	const shape = String(layout.shape || "strip").toLowerCase();
	let width = Math.max(1, Math.floor(number(layout.width, 0)));
	let height = Math.max(1, Math.floor(number(layout.height, 0)));

	if (shape === "rings") {
		// Several identical rings side by side, left to right, one cell apart.
		// The Kraken's 40-LED channel is three 8-LED AER RGB fan rings; the
		// controller's remaining slots carry no LEDs.
		const ringWidth = Math.max(2, width || 3);
		const ringHeight = Math.max(2, height || 3);
		const perimeter = ringPositions(ringWidth, ringHeight);
		const ringCount = Math.max(1, Math.floor(number(layout.count, 0)) || Math.floor(count / perimeter.length) || 1);
		const gap = 1;
		const positions = [];

		for (let r = 0; r < ringCount; r++) {
			const offsetX = r * (ringWidth + gap);

			for (const point of perimeter) {
				if (positions.length >= count) break;
				positions.push([offsetX + point[0], point[1]]);
			}
		}

		return {
			size: [ringCount * ringWidth + (ringCount - 1) * gap, ringHeight],
			positions,
		};
	}

	if (shape === "ring") {
		if (!width || !height) {
			const side = Math.max(2, Math.ceil((count + 4) / 4));
			width = side;
			height = side;
		}
		width = Math.max(2, width);
		height = Math.max(2, height);
		const ring = ringPositions(width, height);
		if (ring.length === count) return { size: [width, height], positions: ring };
		dlog(`ring ${width}x${height} has ${ring.length} perimeter LEDs, not ${count}; using a strip`);
	}

	if (!width || !height) { width = count; height = 1; }
	if (width * height < count) {
		dlog(`strip ${width}x${height} holds ${width * height} LEDs, not ${count}; using ${count}x1`);
		width = count;
		height = 1;
	}
	const positions = [];
	for (let i = 0; i < count; i++) positions.push([i % width, Math.floor(i / width)]);
	return { size: [width, height], positions };
}

function makeLedNames(entry, positions) {
	const names = [];
	for (const channel of entry.channels) {
		for (let i = 0; i < channel.leds && names.length < positions.length; i++) {
			names.push(`${channel.name} ${i + 1}`);
		}
		if (names.length >= positions.length) break;
	}
	while (names.length < positions.length) names.push(`LED ${names.length + 1}`);
	return names;
}

// ---------------------------------------------------------------------------
// subdevice/channel layout
// ---------------------------------------------------------------------------

let deviceList = [];
let appliedSignature = "";
const appliedSubdevices = Object.create(null);
let lastSentAt = 0;
let lastPayloads = Object.create(null);
const firstFrameLogged = Object.create(null);
let udpFailures = 0;
let udpUnavailableLogged = false;
let ready = false;

function removeSubdevices() {
	if (typeof device === "undefined" || !device) return;
	try {
		const ids = typeof device.getCurrentSubdevices === "function" ? device.getCurrentSubdevices() : [];
		for (const id of ids || []) {
			device.removeSubdevice(id);
			delete appliedSubdevices[id];
		}
	} catch (e) {
		dlog("remove subdevice failed: " + e);
	}
}

function removeChannels() {
	if (typeof device === "undefined" || !device) return;
	try {
		const names = typeof device.getChannelNames === "function" ? device.getChannelNames() : [];
		for (const name of names || []) device.removeChannel(name);
	} catch (e) {
		dlog("remove channel failed: " + e);
	}
}

function uniqueChannelName(base, used) {
	let name = String(base || "Channel").trim() || "Channel";
	if (used.has(name)) {
		let suffix = 2;
		while (used.has(`${name} (${suffix})`)) suffix++;
		name = `${name} (${suffix})`;
	}
	used.add(name);
	return name;
}

function createChannels() {
	try {
		if (typeof device.setSize === "function") device.setSize([1, 1]);
		if (typeof device.setControllableLeds === "function") device.setControllableLeds([], []);
	} catch (e) {
		dlog("clear parent canvas failed: " + e);
	}
	const used = new Set();
	for (const entry of deviceList) {
		entry.channelNames = [];
		for (const channel of entry.channels) {
			const name = uniqueChannelName(channel.name || entry.name || entry.id, used);
			entry.channelNames.push({ name, leds: channel.leds });
			device.addChannel(name, channel.leds);
		}
	}
}

// SignalRGB stores a subdevice's canvas position and scale by its uid. Removing
// and recreating the subdevice discards that placement, so an unchanged or
// merely renamed device must be updated in place: create only ids that are new,
// remove only ids that are gone, and touch a live subdevice only when its name
// or geometry really changed. `appliedSubdevices` is the last geometry written
// per uid, so a 15 s refresh that returns the same descriptor is a no-op.
function syncSubdevices() {
	const current = typeof device.getCurrentSubdevices === "function" ? device.getCurrentSubdevices() || [] : [];
	const desired = new Set(deviceList.map(entry => entry.subdeviceId));
	for (const id of current) {
		if (!desired.has(id)) {
			device.removeSubdevice(id);
			delete appliedSubdevices[id];
		}
	}
	for (const entry of deviceList) {
		entry.layoutInfo = layoutFor(entry);
		const positions = entry.layoutInfo.positions;
		const size = entry.layoutInfo.size;
		const names = makeLedNames(entry, positions);
		const key = JSON.stringify([entry.name, size[0], size[1], names, positions]);
		const exists = current.indexOf(entry.subdeviceId) !== -1;
		if (exists && appliedSubdevices[entry.subdeviceId] === key) continue;
		if (!exists) device.createSubdevice(entry.subdeviceId);
		device.setSubdeviceName(entry.subdeviceId, entry.name);
		if (typeof device.setSubdeviceImage === "function") device.setSubdeviceImage(entry.subdeviceId, "");
		device.setSubdeviceSize(entry.subdeviceId, size[0], size[1]);
		// The API takes x and y as two parallel arrays, not [x, y] pairs: passing
		// pairs makes every LED sample the same pixel (the whole device lights as
		// one unit). Same shape the shipped RmlAPPSync plugin uses.
		device.setSubdeviceLeds(
			entry.subdeviceId,
			names,
			positions.map(point => point[0]),
			positions.map(point => point[1]),
		);
		appliedSubdevices[entry.subdeviceId] = key;
	}
}

let lastLedLimit = -1;
let appliedModel = "";

function syncLayout() {
	if (typeof device === "undefined" || !device) return;
	const model = currentModel();
	if (appliedModel !== "" && appliedModel !== model) {
		if (model === "Channels") removeSubdevices();
		else removeChannels();
	}
	appliedModel = model;
	const total = deviceList.reduce((sum, entry) => {
		const count = model === "Channels"
			? entry.channels.reduce((n, channel) => n + channel.leds, 0)
			: entry.ledCount;
		return sum + count;
	}, 0);
	if (total !== lastLedLimit) {
		try {
			device.SetLedLimit(total);
			lastLedLimit = total;
		} catch (e) {
			dlog("SetLedLimit failed: " + e);
		}
	}
	if (!deviceList.length) return;
	if (model === "Channels") {
		removeChannels();
		createChannels();
	} else {
		try {
			syncSubdevices();
		} catch (e) {
			// Zero-subdevice trap: never leave a subdevice controller with no
			// placeable device. Fall back to the L10-style channel model in-build.
			subdevicesFailed = true;
			dlog("subdevice creation failed (" + e + "); falling back to channels");
			removeSubdevices();
			removeChannels();
			appliedModel = "Channels";
			createChannels();
		}
	}
	dlog(`layout=${model} devices=${deviceList.length} leds=${total}`);
}

function setDevices(list) {
	const signature = JSON.stringify(list.map(entry => ({
		id: entry.id,
		index: entry.index,
		name: entry.name,
		ledCount: entry.ledCount,
		udpPort: entry.udpPort,
		channels: entry.channels,
		layout: entry.layout,
	})));
	if (signature === appliedSignature) return false;
	appliedSignature = signature;
	deviceList = list;
	syncLayout();
	return true;
}

// ---------------------------------------------------------------------------
// HTTP descriptor refresh
// ---------------------------------------------------------------------------

let cachedDevices = [];
let descriptorLoaded = false;
let fetchInFlight = false;
let lastFetchAt = 0;
function apiHostValue() {
	const host = typeof apiHost !== "undefined" ? String(apiHost || "").trim() : "";
	return host || LOOPBACK;
}

function apiPortValue() {
	const port = Number(typeof apiPort !== "undefined" ? apiPort : API_PORT);
	return Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.floor(port) : API_PORT;
}

let lastHttpStatus = -1;
let bridgeFailures = 0;
let bridgeDownLogged = false;

function onBridgeFailure(status) {
	bridgeFailures++;
	if (!bridgeDownLogged) {
		bridgeDownLogged = true;
		dlog(`Yunari unreachable (status ${status}); rendering continues without frames`);
	}
}

function applyDescriptor(json) {
	const list = devicesFromDescriptor(json);
	if (!list.length) {
		dlog("descriptor has no lighting devices; keeping current layout");
		return;
	}
	descriptorLoaded = true;
	cachedDevices = list;
	if (typeof device === "undefined" || !device) return; // discovery sandbox: cache for Initialize
	setDevices(list);
}

function fetchDescriptor(force) {
	if (typeof XMLHttpRequest === "undefined") {
		onBridgeFailure("no XMLHttpRequest");
		return;
	}
	if (fetchInFlight) return;
	const now = Date.now();
	if (!force && now - lastFetchAt < REFRESH_MS) return;
	lastFetchAt = now;
	fetchInFlight = true;

	let finished = false;
	const finish = (status, text) => {
		if (finished) return;
		finished = true;
		fetchInFlight = false;
		if (status !== lastHttpStatus) {
			lastHttpStatus = status;
			dlog(`GET http://${apiHostValue()}:${apiPortValue()}/api/devices status=${status}`);
		}
		if (status !== 200) {
			onBridgeFailure(status);
			return;
		}
		bridgeFailures = 0;
		bridgeDownLogged = false;
		let json;
		try {
			json = JSON.parse(text);
		} catch (e) {
			dlog("descriptor JSON parse failed: " + e);
			return;
		}
		applyDescriptor(json);
	};

	try {
		const xhr = new XMLHttpRequest();
		xhr.open("GET", `http://${apiHostValue()}:${apiPortValue()}/api/devices`, true);
		xhr.timeout = 3000;
		xhr.onreadystatechange = function() {
			if (xhr.readyState === 4) finish(xhr.status, xhr.responseText);
		};
		xhr.onerror = function() { finish(0, ""); };
		xhr.ontimeout = function() { finish(0, ""); };
		xhr.send();
	} catch (e) {
		finish(0, "");
	}
}

// ---------------------------------------------------------------------------
// colours and UDP
// ---------------------------------------------------------------------------

function udpReady() {
	return typeof udp !== "undefined" && udp && typeof udp.send === "function";
}

function onUdpUnavailable() {
	if (!udpUnavailableLogged) {
		udpUnavailableLogged = true;
		dlog("UDP transport unavailable; frames are not being sent");
	}
}

function channelColors(entry) {
	const out = [];
	for (const channel of entry.channelNames || []) {
		let colors = [];
		try {
			const ref = device.channel(channel.name);
			if (ref && typeof ref.getColors === "function") {
				colors = ref.getColors("Inline", "RGB") || ref.getColors("Inline") || [];
			}
		} catch (e) {
			dlog(`getColors ${channel.name} failed: ${e}`);
		}
		for (let i = 0; i < channel.leds; i++) {
			out.push(clampByte(colors[i * 3]), clampByte(colors[i * 3 + 1]), clampByte(colors[i * 3 + 2]));
		}
	}
	while (out.length < entry.ledCount * 3) out.push(0);
	return out.slice(0, entry.ledCount * 3);
}

function subdeviceColors(entry) {
	if (!entry.layoutInfo) entry.layoutInfo = layoutFor(entry);
	const out = [];
	for (const position of entry.layoutInfo.positions) {
		let color = [0, 0, 0];
		try {
			const sampled = device.subdeviceColor(entry.subdeviceId, position[0], position[1]);
			if (sampled && sampled.length >= 3) color = sampled;
		} catch (e) {
			dlog(`subdeviceColor ${entry.subdeviceId} failed: ${e}`);
		}
		out.push(clampByte(color[0]), clampByte(color[1]), clampByte(color[2]));
	}
	while (out.length < entry.ledCount * 3) out.push(0);
	return out.slice(0, entry.ledCount * 3);
}

function deviceColors(entry, forced) {
	if (forced) return solidRgb(hexToRgb(typeof forcedColor !== "undefined" ? forcedColor : "#000000"), entry.ledCount);
	if (currentModel() === "Channels") return channelColors(entry);
	return subdeviceColors(entry);
}

// FNV-1a over every byte: sampling the payload (e.g. every 16th byte) aliases
// LED changes away, so a real frame looks "unchanged" and is skipped.
function payloadKey(rgb) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < rgb.length; i++) {
		hash ^= rgb[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return `${rgb.length}:${hash >>> 0}`;
}

function sendFrame(entry, rgb) {
	if (!udpReady()) {
		onUdpUnavailable();
		return false;
	}
	const packet = [MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], 1, entry.index & 0xff, entry.ledCount & 0xff, (entry.ledCount >> 8) & 0xff];
	for (let i = 0; i < entry.ledCount * 3; i++) packet.push(clampByte(rgb[i]));
	udp.send(apiHostValue(), entry.udpPort || DEFAULT_UDP_PORT, packet);
	udpFailures = 0;
	return true;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

export function Initialize() {
	device.setName("Yunari");
	try {
		device.addFeature("udp");
	} catch (e) {
		// not all builds expose addFeature
	}
	bridgeDownLogged = false;
	lastHttpStatus = -1;
	udpUnavailableLogged = false;
	const seed = cachedDevices.length ? cachedDevices : parseFallback(typeof devices !== "undefined" ? devices : DEFAULT_DEVICES);
	appliedSignature = "";
	lastLedLimit = -1;
	appliedModel = "";
	for (const id of Object.keys(appliedSubdevices)) delete appliedSubdevices[id];
	for (const id of Object.keys(firstFrameLogged)) delete firstFrameLogged[id];
	setDevices(seed);
	ready = true;
	fetchDescriptor(true);
	dlog(`ready: model=${currentModel()} devices=${deviceList.length} descriptor=${descriptorLoaded}`);
}

export function Render() {
	if (!ready) return;
	try {
		fetchDescriptor(false);
	} catch (e) {
		// refresh must never break rendering
	}
	try {
		const now = Date.now();
		if (now - lastSentAt < MIN_INTERVAL_MS) return;
		lastSentAt = now;
		const forced = typeof LightingMode !== "undefined" && LightingMode === "Forced";
		for (const entry of deviceList) {
			let rgb;
			try {
				rgb = deviceColors(entry, forced);
			} catch (e) {
				dlog(`colour read ${entry.id} failed: ${e}`);
				continue;
			}
			const key = payloadKey(rgb);
			if (!firstFrameLogged[entry.id]) {
				firstFrameLogged[entry.id] = true;
				const distinct = new Set();
				for (let i = 0; i + 2 < rgb.length; i += 3) distinct.add(`${rgb[i]},${rgb[i + 1]},${rgb[i + 2]}`);
				dlog(`first frame ${entry.id} leds=${entry.ledCount} distinct=${distinct.size} model=${currentModel()}`);
			}
			if (lastPayloads[entry.id] === key) continue;
			let sent = false;
			try {
				sent = sendFrame(entry, rgb);
			} catch (e) {
				udpFailures++;
				if (udpFailures === 1) dlog(`UDP send ${entry.id} failed: ${e}`);
			}
			if (sent) lastPayloads[entry.id] = key;
		}
	} catch (e) {
		// Render must never throw into SignalRGB
		dlog("Render failed: " + e);
	}
}

export function Shutdown(SystemSuspending) {
	const hex = SystemSuspending ? "#000000" : (typeof shutdownColor !== "undefined" ? shutdownColor : "#000000");
	const color = hexToRgb(hex);
	for (const entry of deviceList) {
		try {
			sendFrame(entry, solidRgb(color, entry.ledCount));
		} catch (e) {
			// shutdown is best effort; Yunari may already be gone
		}
	}
}

export function onlayoutModelChanged() {
	syncLayout();
}

export function ondevicesChanged() {
	if (descriptorLoaded) {
		dlog("Yunari descriptor is active; the fallback devices parameter is ignored");
		return;
	}
	setDevices(parseFallback(typeof devices !== "undefined" ? devices : DEFAULT_DEVICES));
}

// ---------------------------------------------------------------------------
// discovery: one controller at loopback, no mDNS and no hardware probing
// ---------------------------------------------------------------------------

class YunariController {
	constructor() {
		this.id = STABLE_ID;
		this.name = "Yunari";
		this.hostname = apiHostValue();
		this.ip = apiHostValue();
		this.port = apiPortValue();
		this.streamingPort = DEFAULT_UDP_PORT;
		this.deviceledcount = 0;
		this.firmwareversion = "";
		this.defaultOn = true;
		this.defaultBri = 255;
		this.readyToAnnounce = true;
		this.announced = false;
		this.connected = true;
		this.offline = false;
		this.lastUpdate = Date.now();
	}

	announce() {
		try {
			service.saveSetting(this.id, "name", this.name);
			service.saveSetting(this.id, "ip", this.ip);
			service.saveSetting(this.id, "port", this.port);
			this.readyToAnnounce = true;
			service.updateController(this);
			service.announceController(this);
			this.announced = true;
			this.connected = true;
			dlog(`announced ${this.name} id=${this.id} ip=${this.ip}:${this.port}`);
		} catch (e) {
			dlog("announceController failed: " + e);
		}
	}
}

function findController() {
	try {
		const existing = service.getController(STABLE_ID);
		if (existing !== undefined) return existing;
	} catch (e) {
		// not cached yet
	}
	try {
		for (const entry of (service.controllers || [])) {
			const candidate = entry && entry.obj ? entry.obj : entry;
			if (!candidate) continue;
			if (candidate.name === "Yunari") {
				dlog("adopting controller from service.controllers: " + candidate.id);
				candidate.id = STABLE_ID;
				return candidate;
			}
		}
	} catch (e) {
		dlog("controller scan failed: " + e);
	}
	return undefined;
}

// Announce before any HTTP probe so Yunari exists in Devices even while Yunari
// is stopped; the descriptor only fills in per-device names and geometry.
function announceFromConfig() {
	try {
		let controller = findController();
		if (controller === undefined) {
			controller = new YunariController();
			service.addController(controller);
		} else {
			controller.ip = apiHostValue();
			controller.hostname = apiHostValue();
			controller.port = apiPortValue();
			service.updateController(controller);
		}
		controller.announce();
	} catch (e) {
		dlog("announceFromConfig failed: " + e);
	}
}

export function DiscoveryService() {
	this.IconUrl = "";
	this.Initialize = function() {
		announceFromConfig();
		fetchDescriptor(true);
	};
	this.Update = function() {
		fetchDescriptor(false);
	};
	this.forceDiscover = function() {
		fetchDescriptor(true);
	};
	this.Discovered = function(value) {
		dlog("Discovered callback: " + JSON.stringify(value));
	};
	this.Removal = function(value) {
		dlog("Removal callback: " + JSON.stringify(value));
	};
}
