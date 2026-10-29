// The imports googlesql.wasm needs: a handful of WASI preview1 functions and one Emscripten callback. The module never
//   opens files or reads input (NO_FILESYSTEM), so these only have to handle what the C++ runtime touches: writing to
//   stdout/stderr, the clock, the environment, and exit. Keeping the shim here, rather than using node:wasi, means the
//   same code runs in Node and in a browser.
const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;
const WASI_ENOSYS = 52;

// onWrite(fd, text) receives everything the module writes to stdout (1) or stderr (2)
export default function createImports({ getMemory, onWrite }) {
	const decoder = new TextDecoder();
	const pending = { 1: '', 2: '' };

	function flush(fd) {
		if (pending[fd]) {
			onWrite(fd, pending[fd]);
			pending[fd] = '';
		}
	}

	return {
		wasi_snapshot_preview1: {
			fd_write(fd, iovsPtr, iovsLength, writtenPtr) {
				if (fd !== 1 && fd !== 2) {
					return WASI_EBADF;
				}
				const view = new DataView(getMemory().buffer);
				const heap = new Uint8Array(getMemory().buffer);
				let written = 0;
				for (let i = 0; i < iovsLength; i++) {
					const pointer = view.getUint32(iovsPtr + i * 8, true);
					const length = view.getUint32(iovsPtr + i * 8 + 4, true);
					pending[fd] += decoder.decode(heap.subarray(pointer, pointer + length));
					written += length;
				}
				view.setUint32(writtenPtr, written, true);
				// Deliver complete lines, so that a message isn't split across writes
				const lastNewline = pending[fd].lastIndexOf('\n');
				if (lastNewline !== -1) {
					onWrite(fd, pending[fd].slice(0, lastNewline + 1));
					pending[fd] = pending[fd].slice(lastNewline + 1);
				}
				return WASI_ESUCCESS;
			},
			fd_read() {
				return WASI_EBADF;
			},
			fd_close() {
				return WASI_ESUCCESS;
			},
			fd_seek() {
				return WASI_ENOSYS;
			},
			clock_time_get(clockId, precision, timePtr) {
				const view = new DataView(getMemory().buffer);
				const nowMs = clockId === 0 ? Date.now() : performance.now();
				view.setBigUint64(timePtr, BigInt(Math.round(nowMs * 1e6)), true);
				return WASI_ESUCCESS;
			},
			environ_sizes_get(countPtr, sizePtr) {
				const view = new DataView(getMemory().buffer);
				view.setUint32(countPtr, 0, true);
				view.setUint32(sizePtr, 0, true);
				return WASI_ESUCCESS;
			},
			environ_get() {
				return WASI_ESUCCESS;
			},
			proc_exit(code) {
				flush(1);
				flush(2);
				throw new Error(`googlesql.wasm exited with code ${code}`);
			},
		},
		env: {
			emscripten_notify_memory_growth() {},
		},
	};
}
