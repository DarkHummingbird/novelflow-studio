import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, open, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { hour } from '../db';
import { json, rate, RequestError } from '../http';
import { stitchScreens } from './stitch';
import type { Screen } from './stitch';

const maxBytes = 100 * 1024 * 1024;
const mediaTypes = new Map([
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/x-m4v', 'm4v'],
]);
const run = promisify(execFile);
let running = 0;

function decode(stdout: string): Screen[] {
  const frames: unknown = JSON.parse(stdout);
  if (!Array.isArray(frames) || frames.length > 362 ||
      frames.some((frame) => !Number.isFinite(frame?.at) || !Array.isArray(frame?.lines) ||
        frame.lines.length > 300 || frame.lines.some((line: Screen['lines'][number]) =>
          typeof line?.text !== 'string' || !Number.isFinite(line.y)))) {
    throw new RequestError(502, 'ocr_unavailable');
  }
  return frames as Screen[];
}

export async function extractRecording(req: IncomingMessage, res: ServerResponse, ip: string) {
  const type = req.headers['content-type']?.split(';')[0];
  const extension = type && mediaTypes.get(type);
  if (!extension) throw new RequestError(415, 'video_format');
  const advertised = Number(req.headers['content-length'] ?? 0);
  if (advertised > maxBytes) throw new RequestError(413, 'video_size');

  const worker = process.env.NF_OCR_BIN || resolve('dist-server/ocr-video');
  await access(worker, constants.X_OK).catch(() => { throw new RequestError(503, 'ocr_unavailable'); });
  if (running > 0) throw new RequestError(429, 'ocr_busy');
  rate('ocr-ip', ip, hour, 8);
  running++;
  const abort = new AbortController();
  const disconnect = () => abort.abort();
  res.once('close', disconnect);
  const uploadDeadline = setTimeout(() => req.destroy(), 120_000);
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'novelflow-ocr-'));
    const path = join(directory, 'recording.' + extension);
    const file = await open(path, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        abort.signal.throwIfAborted();
        size += chunk.length;
        if (size > maxBytes) {
          res.setHeader('Connection', 'close');
          throw new RequestError(413, 'video_size');
        }
        await file.writeFile(chunk);
      }
    } finally {
      await file.close();
      clearTimeout(uploadDeadline);
    }
    if (!size) throw new RequestError(400, 'invalid_video');
    let stdout: string;
    try {
      ({ stdout } = await run(worker, [path], {
        encoding: 'utf8', signal: abort.signal, timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
        killSignal: 'SIGKILL',
      }));
    } catch (error) {
      if (abort.signal.aborted) return;
      const code = (error as { code?: unknown }).code;
      if (code === 3) throw new RequestError(400, 'invalid_video');
      if (code === 4) throw new RequestError(400, 'video_duration');
      if (code === 5) throw new RequestError(422, 'ocr_empty');
      throw new RequestError(503, 'ocr_unavailable');
    }
    const result = stitchScreens(decode(stdout));
    if (!result.text) throw new RequestError(422, 'ocr_empty');
    json(res, 200, result);
  } finally {
    clearTimeout(uploadDeadline);
    res.off('close', disconnect);
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      running--;
    }
  }
}
