#!/usr/bin/env python3
"""lz-string 的 python 移植(只做 decompressFromBase64 那一套)。
SAILFISH 的 getRaceDatas 返回的 result 就是 lz-string 压过的 JSON。
"""
import base64


class _Data:
    def __init__(self, s, reset, get):
        self.string = s
        self.val = s[0] if hasattr(s, "__getitem__") else s
        self.position = reset
        self.index = 1


def _decompress(length, reset_value, get_next_value):
    """get_next_value(i) 返回第 i 个字符的码值。"""
    dictionary = {}
    enlarge_in = 4
    dict_size = 4
    num_bits = 3
    entry = ""
    result = []

    data_val = [get_next_value(0)]
    data_position = [reset_value]
    data_index = [1]

    def read_bits(n):
        bits = 0
        power = 1
        maxpower = 1 << n
        while power != maxpower:
            resb = data_val[0] & data_position[0]
            data_position[0] >>= 1
            if data_position[0] == 0:
                data_position[0] = reset_value
                data_val[0] = get_next_value(data_index[0])
                data_index[0] += 1
            if resb > 0:
                bits |= power
            power <<= 1
        return bits

    next_code = read_bits(2)
    if next_code == 0:
        c = chr(read_bits(8))
    elif next_code == 1:
        c = chr(read_bits(16))
    elif next_code == 2:
        return ""
    else:
        raise ValueError("bad lz header")

    dictionary[3] = c
    w = c
    result.append(c)
    while True:
        if data_index[0] > length:
            return ""
        code = read_bits(num_bits)
        if code == 0:
            dictionary[dict_size] = chr(read_bits(8))
            dict_size += 1
            code = dict_size - 1
            enlarge_in -= 1
        elif code == 1:
            dictionary[dict_size] = chr(read_bits(16))
            dict_size += 1
            code = dict_size - 1
            enlarge_in -= 1
        elif code == 2:
            return "".join(result)

        if enlarge_in == 0:
            enlarge_in = 1 << num_bits
            num_bits += 1

        if code in dictionary:
            entry = dictionary[code]
        elif code == dict_size:
            entry = w + w[0]
        else:
            return None
        result.append(entry)
        dictionary[dict_size] = w + entry[0]
        dict_size += 1
        w = entry
        enlarge_in -= 1
        if enlarge_in == 0:
            enlarge_in = 1 << num_bits
            num_bits += 1


KEY_STR_BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="


def decompress_from_base64(s):
    s = s.replace(" ", "+")
    return _decompress(len(s), 32, lambda i: KEY_STR_BASE64.find(s[i]))


if __name__ == "__main__":
    import json
    import sys
    raw = open(sys.argv[1], "rb").read() if len(sys.argv) > 1 else sys.stdin.buffer.read()
    o = json.loads(raw)
    print(decompress_from_base64(o["result"]))
