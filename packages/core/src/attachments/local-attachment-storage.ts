import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AiAttachment,
  AiAttachmentStorageAdapter,
} from "../contracts/ai-attachment.js";
import type { AiCaller } from "../contracts/ai-execution-context.js";

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function writeAttachment(
  path: string,
  { data, mediaType, filename }: AiAttachment,
  signal?: AbortSignal,
) {
  // Keep the metadata and bytes together so readers always see one complete version.
  const header = Buffer.from(`${JSON.stringify({ mediaType, filename })}\n`);
  return writeFile(path, [header, data], { flag: "wx", mode: 0o600, signal });
}

export class LocalAttachmentStorage implements AiAttachmentStorageAdapter {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async create(
    caller: AiCaller,
    id: string,
    attachment: AiAttachment,
    signal?: AbortSignal,
  ) {
    const owner = this.ownerDirectory(caller);
    await mkdir(owner, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(owner, ".upload-"));
    try {
      await writeAttachment(join(temporary, "blob"), attachment, signal);
      signal?.throwIfAborted();
      await rename(temporary, join(owner, id));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async read(caller: AiCaller, id: string, signal?: AbortSignal) {
    try {
      const blob = await readFile(
        join(this.ownerDirectory(caller), id, "blob"),
        { signal },
      );
      const newline = blob.indexOf(10);
      if (newline < 0) throw new Error("Malformed attachment.");
      const { mediaType, filename } = JSON.parse(
        blob.toString("utf8", 0, newline),
      );
      return {
        mediaType,
        data: blob.subarray(newline + 1),
        ...(filename === undefined ? {} : { filename }),
      };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return undefined;
    }
  }

  async update(
    caller: AiCaller,
    id: string,
    attachment: AiAttachment,
    signal?: AbortSignal,
  ) {
    const directory = join(this.ownerDirectory(caller), id);
    const temporary = join(directory, randomUUID());
    try {
      await writeAttachment(temporary, attachment, signal);
      signal?.throwIfAborted();
      await rename(temporary, join(directory, "blob"));
      return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return false;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async delete(caller: AiCaller, id: string, signal?: AbortSignal) {
    const owner = this.ownerDirectory(caller);
    const removed = join(owner, `.deleted-${randomUUID()}`);
    try {
      signal?.throwIfAborted();
      // Removing the directory in one step prevents a concurrent update from recreating it.
      await rename(join(owner, id), removed);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return false;
    }
    await rm(removed, { recursive: true, force: true });
    return true;
  }

  private ownerDirectory({ tenantId, subjectId }: AiCaller): string {
    const owner = createHash("sha256")
      .update(JSON.stringify([tenantId ?? null, subjectId]))
      .digest("hex");
    return join(this.root, owner);
  }
}
