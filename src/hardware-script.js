'use strict';

// This function is serialized into each JavaScript realm. It intentionally
// does not claim native implementation or change physical device capabilities.
function installHardware(config) {
  'use strict';
  const navigatorPrototype = globalThis.navigator && Object.getPrototypeOf(navigator);
  if (!navigatorPrototype) return;
  if (Object.getOwnPropertyDescriptor(navigatorPrototype, 'hardwareConcurrency')?.get?.name === 'getHardwareConcurrency') return;
  const defineGetter = (prototype, name, getter) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor?.configurable) {
      const wrapped = function () { Reflect.apply(descriptor.get, this, []); return Reflect.apply(getter, this, []); };
      Object.defineProperty(wrapped, 'name', { value: getter.name });
      Object.defineProperty(prototype, name, { ...descriptor, get: wrapped });
    }
  };
  defineGetter(navigatorPrototype, 'hardwareConcurrency', function getHardwareConcurrency() { return config.hardwareConcurrency; });
  defineGetter(navigatorPrototype, 'deviceMemory', function getDeviceMemory() { return config.deviceMemory; });
  if (navigator.hardwareConcurrency !== config.hardwareConcurrency || ('deviceMemory' in navigator && navigator.deviceMemory !== config.deviceMemory)) throw new Error('Hardware navigator configuration failed');
  const mix = value => { value = Math.imul(value ^ (value >>> 16), 0x45d9f3b); value = Math.imul(value ^ (value >>> 16), 0x45d9f3b); return (value ^ (value >>> 16)) >>> 0; };
  const hashAt = (x, y, width, height) => mix((config.seed[0] ^ Math.imul(x + 1, 73856093)) + Math.imul(config.seed[1] ^ y, 19349663) ^ mix(config.seed[2] + width + x) ^ config.seed[3] ^ height);
  const pixels = (data, width, height, canvasWidth, canvasHeight, x = 0, y = 0, flip = false, stride = width * 4) => {
    if (!config.canvasNoise || data.BYTES_PER_ELEMENT !== 1) return;
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      const px = x + column, py = flip ? canvasHeight - y - row - 1 : y + row;
      const offset = row * stride + column * 4;
      if (px < 0 || py < 0 || px >= canvasWidth || py >= canvasHeight || data[offset + 3] !== 255) continue;
      const hash = hashAt(px, py, canvasWidth, canvasHeight);
      if (hash % 16) continue;
      const index = offset + hash % 3;
      // Assign one bit instead of adding noise: repeated readbacks and
      // PNG round-trips stay stable, with no cumulative pixel drift.
      data[index] = (data[index] & 254) | ((hash >>> 8) & 1);
    }
  };
  const canvas2D = globalThis.CanvasRenderingContext2D?.prototype;
  const offscreen2D = globalThis.OffscreenCanvasRenderingContext2D?.prototype;
  const readPixels = new Map();
  for (const prototype of [canvas2D, offscreen2D].filter(Boolean)) {
    const original = prototype.getImageData;
    readPixels.set(prototype, original);
    if (config.canvasNoise) prototype.getImageData = function getImageData(...args) {
      const image = Reflect.apply(original, this, args);
      let x = Math.trunc(Number(args[0]) || 0), y = Math.trunc(Number(args[1]) || 0);
      if (Number(args[2]) < 0) x += Math.trunc(Number(args[2]));
      if (Number(args[3]) < 0) y += Math.trunc(Number(args[3]));
      pixels(image.data, image.width, image.height, this.canvas.width, this.canvas.height, x, y);
      return image;
    };
  }
  const clone = source => {
    const copy = globalThis.OffscreenCanvas && source instanceof OffscreenCanvas ? new OffscreenCanvas(source.width, source.height) : document.createElement('canvas');
    copy.width = source.width; copy.height = source.height;
    const context = copy.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    const original = readPixels.get(Object.getPrototypeOf(context));
    const image = Reflect.apply(original, context, [0, 0, copy.width, copy.height]);
    pixels(image.data, image.width, image.height, copy.width, copy.height);
    context.putImageData(image, 0, 0);
    return copy;
  };
  if (config.canvasNoise && globalThis.HTMLCanvasElement) {
    for (const method of ['toDataURL', 'toBlob']) {
      const original = HTMLCanvasElement.prototype[method];
      HTMLCanvasElement.prototype[method] = function (...args) {
        return Reflect.apply(original, this.width && this.height ? clone(this) : this, args);
      };
    }
  }
  if (config.canvasNoise && globalThis.OffscreenCanvas) {
    const original = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = function (...args) {
      const copy = this.width && this.height ? clone(this) : this;
      return Reflect.apply(original, copy, args);
    };
  }
  for (const prototype of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype].filter(Boolean)) {
    const getParameter = prototype.getParameter;
    prototype.getParameter = function getParameterWithHardware(parameter) {
      const value = Reflect.apply(getParameter, this, [parameter]);
      if (value != null && config.gpu.vendor) {
        if (parameter === 37445) return config.gpu.vendor;
        if (parameter === 37446) return config.gpu.renderer;
      }
      return value;
    };
    const original = prototype.readPixels;
    if (!config.canvasNoise) continue;
    prototype.readPixels = function (...args) {
      const result = Reflect.apply(original, this, args);
      const [x, y, width, height, format, type, destination, offset = 0] = args;
      if (format === 6408 && type === 5121 && ArrayBuffer.isView(destination) && destination.BYTES_PER_ELEMENT === 1) {
        const alignment = Reflect.apply(getParameter, this, [3333]);
        const rowLength = globalThis.WebGL2RenderingContext && this instanceof WebGL2RenderingContext ? Reflect.apply(getParameter, this, [3330]) || width : width;
        const stride = Math.ceil(rowLength * 4 / alignment) * alignment;
        const skipRows = globalThis.WebGL2RenderingContext && this instanceof WebGL2RenderingContext ? Reflect.apply(getParameter, this, [3331]) : 0;
        const skipPixels = globalThis.WebGL2RenderingContext && this instanceof WebGL2RenderingContext ? Reflect.apply(getParameter, this, [3332]) : 0;
        const start = offset + skipRows * stride + skipPixels * 4;
        if ([1, 2, 4, 8].includes(alignment) && [x, y, width, height].every(Number.isInteger) && width > 0 && height > 0 && rowLength >= width && destination.length >= start + (height - 1) * stride + width * 4) {
          pixels(destination.subarray(start), width, height, this.drawingBufferWidth, this.drawingBufferHeight, x, y, true, stride);
        }
      }
      return result;
    };
  }
  if (config.gpu.vendor && globalThis.GPUAdapterInfo) {
    for (const [name, value] of Object.entries({ vendor: config.gpu.webgpuVendor, architecture: '', device: '', description: config.gpu.name })) {
      defineGetter(GPUAdapterInfo.prototype, name, function getAdapterInformation() { return value; });
    }
  }
  if (config.audioNoise && globalThis.AudioBuffer) {
    const original = AudioBuffer.prototype.getChannelData, changed = new WeakMap();
    const prepare = (buffer, channel) => {
      const data = Reflect.apply(original, buffer, [channel]);
      let channels = changed.get(buffer); if (!channels) { channels = new Set(); changed.set(buffer, channels); }
      if (!channels.has(channel)) {
        const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
        for (let index = 0; index < data.length; index++) {
          const hash = hashAt(index, channel, buffer.length, buffer.sampleRate);
          if (data[index] && Number.isFinite(data[index]) && hash % 16 === 0) bits[index] = (bits[index] & 0xfffffffe) | ((hash >>> 8) & 1);
        }
        channels.add(channel);
      }
      return data;
    };
    AudioBuffer.prototype.getChannelData = function getChannelData(channel) { return prepare(this, channel); };
    const copy = AudioBuffer.prototype.copyFromChannel;
    AudioBuffer.prototype.copyFromChannel = function (...args) { prepare(this, args[1]); return Reflect.apply(copy, this, args); };
    const write = AudioBuffer.prototype.copyToChannel;
    AudioBuffer.prototype.copyToChannel = function (...args) {
      const result = Reflect.apply(write, this, args);
      changed.get(this)?.delete(args[1]);
      return result;
    };
  }
}

function hardwareScript(config) { return `(${installHardware.toString()})(${JSON.stringify(config)});`; }
module.exports = { hardwareScript };
