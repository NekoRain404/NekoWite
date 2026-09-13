---
title: MDX 语法速查
tags: [demo, mdx]
---

# MDX 语法速查

这里总结 NekoWite 支持的 MDX 语法，用于 [[demo]] 的辅助验证。

## 图片语法

```md
![alt](path.png "title"){width=400 align=center}
```

## MDX 组件

```mdx
<Callout type="info">内容</Callout>
<FloatBox x="10" y="10" w="200" h="120" angle="0">内容</FloatBox>
```

## 数学

```md
行内：$E = mc^2$
块级：
$$
e^{i\pi} + 1 = 0
$$
```

## 引用

```md
[@smith2020]
```

## Wikilink

```md
[[notes/neko-notes]]
[[notes/neko-notes|Neko]]
```

返回 [[demo]]。
