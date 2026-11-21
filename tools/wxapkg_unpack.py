#!/usr/bin/env python3
"""解密并解开微信 macOS 版缓存的 .wxapkg(V1MMWX 加密格式),导出到指定目录。

用法: python3 wxapkg_unpack.py <appid> <pkg.wxapkg> <outdir>
依赖: 只用 hashlib/struct/openssl 命令行,不装第三方库。
"""
import hashlib
import os
import struct
import subprocess
import sys
import tempfile


def aes_cbc_decrypt(key: bytes, iv: bytes, buf: bytes) -> bytes:
    buf = buf[: len(buf) // 16 * 16]  # 尾部不足一块的字节丢掉
    with tempfile.NamedTemporaryFile(delete=False) as fin:
        fin.write(buf)
        inp = fin.name
    out = inp + ".dec"
    subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-nopad",
         "-K", key.hex(), "-iv", iv.hex(), "-in", inp, "-out", out],
        check=True, capture_output=True,
    )
    with open(out, "rb") as f:
        data = f.read()
    os.unlink(inp)
    os.unlink(out)
    return data


def unwrap(path: str, appid: str) -> bytes:
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:6] != b"V1MMWX":
        return raw  # 已经是明文包
    key = hashlib.pbkdf2_hmac("sha1", appid.encode(), b"saltiest", 1000, 32)
    iv = b"the iv: 16 bytes"
    head = aes_cbc_decrypt(key, iv, raw[6:6 + 1024])
    rest = aes_cbc_decrypt(key, iv, raw[6 + 1024:])
    body = head + rest
    # 去掉尾部 PKCS7 填充
    pad = body[-1]
    if 1 <= pad <= 16 and body[-pad:] == bytes([pad]) * pad:
        body = body[:-pad]
    return body


def unpack(body: bytes, outdir: str) -> list:
    if body[:1] != b"\xbe":
        raise SystemExit("解开后不是 wxapkg(第一字节不是 0xBE),大概率是 appid 或格式对不上")
    pos = 1 + 4  # 0xBE + info1
    index_len = struct.unpack(">I", body[pos:pos + 4])[0]
    pos += 4
    body_len = struct.unpack(">I", body[pos:pos + 4])[0]
    pos += 4
    if body[pos] != 0xED:
        raise SystemExit("索引标记不对,不是标准 v0 包")
    pos += 1
    count = struct.unpack(">I", body[pos:pos + 4])[0]
    pos += 4
    entries = []
    for _ in range(count):
        nlen = struct.unpack(">I", body[pos:pos + 4])[0]
        pos += 4
        name = body[pos:pos + nlen].decode("utf-8", "replace")
        pos += nlen
        off, size = struct.unpack(">II", body[pos:pos + 8])
        pos += 8
        entries.append((name, off, size))
    data_start = pos
    os.makedirs(outdir, exist_ok=True)
    for name, off, size in entries:
        target = os.path.join(outdir, name.lstrip("/"))
        os.makedirs(os.path.dirname(target) or outdir, exist_ok=True)
        with open(target, "wb") as f:
            f.write(body[data_start + off: data_start + off + size])
    return entries


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    appid, pkg, outdir = sys.argv[1:]
    body = unwrap(pkg, appid)
    entries = unpack(body, outdir)
    print(f"{len(entries)} 个文件 -> {outdir}")
    for name, off, size in entries:
        print(f"  {size:>8}  {name}")


if __name__ == "__main__":
    main()
