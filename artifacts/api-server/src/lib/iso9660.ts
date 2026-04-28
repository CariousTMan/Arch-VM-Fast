import { promises as fs } from "fs";
import type { FileHandle } from "fs/promises";

const SECTOR = 2048;

export interface IsoVolumeInfo {
  volumeLabel: string;
  rootLba: number;
  rootSize: number;
  jolietRootLba?: number;
  jolietRootSize?: number;
}

export interface IsoDirEntry {
  name: string;
  lba: number;
  length: number;
  isDir: boolean;
}

export class IsoReader {
  private fd: FileHandle;
  size: number;

  private constructor(fd: FileHandle, size: number) {
    this.fd = fd;
    this.size = size;
  }

  static async open(path: string): Promise<IsoReader> {
    const fd = await fs.open(path, "r");
    const stat = await fd.stat();
    return new IsoReader(fd, stat.size);
  }

  async close(): Promise<void> {
    await this.fd.close();
  }

  async read(offset: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    let pos = 0;
    while (pos < length) {
      const { bytesRead } = await this.fd.read(
        buf,
        pos,
        length - pos,
        offset + pos,
      );
      if (bytesRead === 0) break;
      pos += bytesRead;
    }
    return pos === length ? buf : buf.subarray(0, pos);
  }

  async readSector(lba: number, sectors = 1): Promise<Buffer> {
    return this.read(lba * SECTOR, sectors * SECTOR);
  }

  async parseVolumeInfo(): Promise<IsoVolumeInfo> {
    let pvdLabel = "";
    let rootLba = 0;
    let rootSize = 0;
    let jolietRootLba: number | undefined;
    let jolietRootSize: number | undefined;

    for (let lba = 16; lba < 64; lba++) {
      const sec = await this.readSector(lba);
      if (sec.length < SECTOR) break;
      const type = sec[0];
      const id = sec.slice(1, 6).toString("ascii");
      if (id !== "CD001") break;
      if (type === 255) break; // terminator

      if (type === 1) {
        // Primary Volume Descriptor
        pvdLabel = sec.slice(40, 72).toString("ascii").trimEnd();
        const rootDr = sec.slice(156, 156 + 34);
        rootLba = rootDr.readUInt32LE(2);
        rootSize = rootDr.readUInt32LE(10);
      } else if (type === 2) {
        // Supplementary Volume Descriptor — Joliet?
        const escSeq = sec.slice(88, 120);
        const isJoliet =
          escSeq.includes(Buffer.from([0x25, 0x2f, 0x40])) || // %/@ UCS-2 level 1
          escSeq.includes(Buffer.from([0x25, 0x2f, 0x43])) || // %/C UCS-2 level 2
          escSeq.includes(Buffer.from([0x25, 0x2f, 0x45])); // %/E UCS-2 level 3
        if (isJoliet) {
          const rootDr = sec.slice(156, 156 + 34);
          jolietRootLba = rootDr.readUInt32LE(2);
          jolietRootSize = rootDr.readUInt32LE(10);
        }
      }
    }

    if (rootLba === 0)
      throw new Error("ISO9660: no Primary Volume Descriptor found");

    return {
      volumeLabel: pvdLabel,
      rootLba,
      rootSize,
      jolietRootLba,
      jolietRootSize,
    };
  }

  async readDir(
    lba: number,
    size: number,
    isJoliet: boolean,
  ): Promise<IsoDirEntry[]> {
    const sectors = Math.ceil(size / SECTOR);
    const buf = await this.readSector(lba, sectors);
    const out: IsoDirEntry[] = [];
    let pos = 0;
    while (pos < size) {
      const len = buf[pos];
      if (!len) {
        // Padding to next sector boundary
        pos = (Math.floor(pos / SECTOR) + 1) * SECTOR;
        continue;
      }
      const recLba = buf.readUInt32LE(pos + 2);
      const recSize = buf.readUInt32LE(pos + 10);
      const flags = buf[pos + 25];
      const isDir = (flags & 0x02) !== 0;
      const nameLen = buf[pos + 32];

      let name: string;
      if (isJoliet) {
        let s = "";
        for (let i = 0; i < nameLen; i += 2) {
          s += String.fromCharCode(buf.readUInt16BE(pos + 33 + i));
        }
        name = s;
      } else {
        name = buf.slice(pos + 33, pos + 33 + nameLen).toString("ascii");
      }

      // Skip the version suffix ";1"
      const semi = name.indexOf(";");
      if (semi >= 0) name = name.slice(0, semi);

      // Skip "." (00) and ".." (01) self-references
      const isSelfRef =
        nameLen === 1 && (buf[pos + 33] === 0x00 || buf[pos + 33] === 0x01);
      if (!isSelfRef) {
        out.push({ name, lba: recLba, length: recSize, isDir });
      }

      pos += len;
    }
    return out;
  }

  async findFile(
    pathStr: string,
  ): Promise<{ lba: number; length: number } | null> {
    const info = await this.parseVolumeInfo();
    const useJoliet = info.jolietRootLba !== undefined;
    let curLba = useJoliet ? info.jolietRootLba! : info.rootLba;
    let curSize = useJoliet ? info.jolietRootSize! : info.rootSize;

    const parts = pathStr.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const want = parts[i].toLowerCase();
      const entries = await this.readDir(curLba, curSize, useJoliet);
      const match = entries.find(
        (e) =>
          e.name.toLowerCase() === want && (isLast ? !e.isDir : e.isDir),
      );
      if (!match) return null;
      curLba = match.lba;
      curSize = match.length;
    }
    return { lba: curLba, length: curSize };
  }
}
