#!/usr/bin/env python3
"""把 index.html 里那些 `<script src="js/xxx.js"></script>` 就地换成文件内容。

打单文件包(build_standalone.py / build_live.py)都走这里。
多个 js 文件按它们在 index.html 里出现的顺序内联,顺序就是加载顺序 ——
这些文件之间是共享全局的(state.js 里的 S、api.js 里的 getJSON),顺序不能乱。
"""
import os
import re

TAG = re.compile(r'<script src="([^"]+)"></script>')


def inline_local_scripts(html, viewer_dir, before_first=""):
    """viewer_dir 是 index.html 所在的目录。before_first 塞在第一个脚本前面。"""
    first = [True]

    def repl(m):
        src = m.group(1)
        if re.match(r'^[a-z]+://|^//', src):
            return m.group(0)                      # 外链不动
        path = os.path.join(viewer_dir, src)
        code = open(path, encoding="utf-8").read()
        assert "</script" not in code, f"{src} 里有 </script,得先处理"
        head = ""
        if first[0]:
            first[0] = False
            head = before_first
        return f"{head}<script>\n{code}\n</script>"

    return TAG.sub(repl, html)
