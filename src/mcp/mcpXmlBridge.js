const MCP_XML_ENV = "AG2API_MCP_XML_ENABLED";

function isMcpXmlEnabled() {
  const raw = process.env[MCP_XML_ENV];
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isMcpToolName(name) {
  return typeof name === "string" && name.startsWith("mcp__");
}

function getMcpTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return list.filter((t) => isMcpToolName(t?.name));
}

function getMcpToolNames(tools) {
  return getMcpTools(tools)
    .map((t) => t.name)
    .filter((n) => typeof n === "string" && n);
}

function safeJsonStringify(value, maxLen = 8000) {
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string" && text.length > maxLen) return text.slice(0, maxLen) + "...";
    return text;
  } catch (_) {
    return "";
  }
}

function buildMcpXmlSystemPrompt(mcpTools) {
  const tools = Array.isArray(mcpTools) ? mcpTools : [];
  if (tools.length === 0) return "";

  const lines = [];
  lines.push("==== MCP XML 工具调用（仅 mcp__*） ====");
  lines.push("当你需要调用名称以 `mcp__` 开头的 MCP 工具时：");
  lines.push("1) 不要使用 tool_use/function_call（因为该链路会报错）。");
  lines.push("2) 直接输出一个 XML 块（只输出 XML，不要解释/不要 markdown）。");
  lines.push("3) XML 的根标签必须是工具名，内容必须是 JSON（对象/数组），表示该工具的入参。");
  lines.push("");
  lines.push("示例：");
  lines.push("<mcp__server__tool>{\"arg\":\"value\"}</mcp__server__tool>");
  lines.push("");
  lines.push("工具执行完成后，我会把结果以如下 XML 返回给你：");
  lines.push("<mcp_tool_result>{\"name\":\"mcp__server__tool\",\"tool_use_id\":\"toolu_xxx\",\"result\":\"...\"}</mcp_tool_result>");
  lines.push("");
  lines.push("对于非 `mcp__*` 工具：继续使用正常的工具调用机制。");
  lines.push("");
  lines.push("可用 MCP 工具列表（name / description / input_schema）：");

  for (const tool of tools) {
    const name = tool?.name;
    if (!isMcpToolName(name)) continue;
    const desc = typeof tool?.description === "string" ? tool.description : "";
    const schema = tool?.input_schema || tool?.inputSchema || null;
    lines.push(`- ${name}${desc ? `: ${desc}` : ""}`);
    if (schema) {
      lines.push(`  input_schema: ${safeJsonStringify(schema, 4000)}`);
    }
  }

  return lines.join("\n");
}

function buildMcpToolCallXml(name, input) {
  const toolName = String(name || "");
  const payload = safeJsonStringify(input ?? {}, 20000) || "{}";
  return `<${toolName}>${payload}</${toolName}>`;
}

function buildMcpToolResultXml(toolName, toolUseId, resultText) {
  const payload = {
    name: String(toolName || ""),
    tool_use_id: String(toolUseId || ""),
    result: typeof resultText === "string" ? resultText : safeJsonStringify(resultText, 20000),
  };
  return `<mcp_tool_result>${safeJsonStringify(payload, 40000) || "{}"}</mcp_tool_result>`;
}

function parseXmlToObject(xml) {
  const input = String(xml || "");
  const tokens = [];
  const re = /<\/?[A-Za-z0-9_:.\\-]+\s*\/?>|[^<]+/g;
  let match;
  while ((match = re.exec(input))) tokens.push(match[0]);

  const stack = [{ name: "root", children: [], text: "" }];
  for (const token of tokens) {
    if (token.startsWith("<")) {
      const isClose = token.startsWith("</");
      const isSelfClose = token.endsWith("/>");
      const tagName = token.replace(/^<\/?/, "").replace(/\s*\/?>$/, "").trim();
      if (!tagName) continue;
      if (isClose) {
        if (stack.length <= 1) continue;
        const node = stack.pop();
        const parent = stack[stack.length - 1];
        parent.children.push(node);
      } else if (isSelfClose) {
        const parent = stack[stack.length - 1];
        parent.children.push({ name: tagName, children: [], text: "" });
      } else {
        stack.push({ name: tagName, children: [], text: "" });
      }
    } else {
      const current = stack[stack.length - 1];
      current.text += token;
    }
  }

  while (stack.length > 1) {
    const node = stack.pop();
    const parent = stack[stack.length - 1];
    parent.children.push(node);
  }

  function nodeToValue(node) {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const text = typeof node.text === "string" ? node.text.trim() : "";
    if (!hasChildren) return text;

    const out = {};
    for (const child of node.children) {
      const v = nodeToValue(child);
      if (Object.prototype.hasOwnProperty.call(out, child.name)) {
        if (Array.isArray(out[child.name])) out[child.name].push(v);
        else out[child.name] = [out[child.name], v];
      } else {
        out[child.name] = v;
      }
    }
    if (text) out._text = text;
    return out;
  }

  return nodeToValue(stack[0]);
}

function tryParseMcpToolCallXml(xmlText, toolName) {
  const name = String(toolName || "");
  const text = String(xmlText || "").trim();
  if (!name || !text) return null;

  const openRe = new RegExp(`^<${name}(?:\\s[^>]*)?>`, "i");
  const closeRe = new RegExp(`</${name}\\s*>$`, "i");
  if (!openRe.test(text) || !closeRe.test(text)) return null;

  const openMatch = text.match(openRe);
  if (!openMatch) return null;
  const closeStart = text.toLowerCase().lastIndexOf(`</${name.toLowerCase()}`);
  if (closeStart === -1 || closeStart < openMatch[0].length) return null;
  const inner = text.slice(openMatch[0].length, closeStart).trim();
  if (!inner) return { name, input: {} };

  if (inner.startsWith("{") || inner.startsWith("[")) {
    try {
      return { name, input: JSON.parse(inner) };
    } catch (_) {
      // fallthrough
    }
  }

  try {
    const wrapped = `<root>${inner}</root>`;
    const obj = parseXmlToObject(wrapped);
    return { name, input: obj.root ?? obj };
  } catch (_) {
    return { name, input: { raw: inner } };
  }
}

function createMcpXmlStreamParser(toolNames) {
  const names = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
  const nameSet = new Set(names);
  let buffer = "";

  function isPossibleToolTagPrefix(text) {
    const frag = String(text || "");
    if (!frag.startsWith("<")) return false;
    for (const name of nameSet) {
      const open = `<${name}`;
      if (open.startsWith(frag)) return true;
      const close = `</${name}`;
      if (close.startsWith(frag)) return true;
    }
    return false;
  }

  function splitBufferForPartialTag(text) {
    const raw = String(text || "");
    if (!raw) return { emit: "", keep: "" };
    const lastLt = raw.lastIndexOf("<");
    if (lastLt === -1) return { emit: raw, keep: "" };
    const tail = raw.slice(lastLt);
    if (isPossibleToolTagPrefix(tail)) return { emit: raw.slice(0, lastLt), keep: tail };
    return { emit: raw, keep: "" };
  }

  function findNextToolStartIndex(text) {
    let best = -1;
    let bestName = null;
    for (const name of nameSet) {
      const open = `<${name}`;
      let searchFrom = 0;
      while (true) {
        const idx = text.indexOf(open, searchFrom);
        if (idx === -1) break;

        // Ensure we only match full tag names, not prefixes (e.g. `<...__fill_form>` should not match `...__fill`).
        const boundaryCh = text[idx + open.length];
        const isBoundary = boundaryCh === ">" || boundaryCh === "/" || /\s/.test(boundaryCh || "");
        if (!boundaryCh || !isBoundary) {
          searchFrom = idx + 1;
          continue;
        }

        if (best === -1 || idx < best) {
          best = idx;
          bestName = name;
        } else if (idx === best && bestName && name.length > bestName.length) {
          // Extra guard: overlapping tool names at the same index.
          bestName = name;
        }
        break;
      }
    }
    return { index: best, name: bestName };
  }

  function pushText(text) {
    const out = [];
    if (!text) return out;
    buffer += String(text);

    function findCloseTagEndIndex(src, toolName) {
      const name = String(toolName || "");
      const needle = `</${name}`;
      let from = 0;
      while (true) {
        const idx = src.indexOf(needle, from);
        if (idx === -1) return -1;
        const after = idx + needle.length;
        const ch = src[after];
        // The close tag is incomplete in the buffer.
        if (ch === undefined) return -1;
        // Must be a boundary char (">" or whitespace). Reject things like `</nameX>`.
        if (!(ch === ">" || /\s/.test(ch))) {
          from = idx + 1;
          continue;
        }
        const gt = src.indexOf(">", after);
        if (gt === -1) return -1;
        // Only allow whitespace between name and ">".
        if (!/^\s*$/.test(src.slice(after, gt))) {
          from = idx + 1;
          continue;
        }
        return gt + 1;
      }
    }

    while (true) {
      const { index, name } = findNextToolStartIndex(buffer);
      if (index === -1 || !name) {
        const { emit, keep } = splitBufferForPartialTag(buffer);
        if (emit) out.push({ type: "text", text: emit });
        buffer = keep;
        break;
      }

      if (index > 0) {
        out.push({ type: "text", text: buffer.slice(0, index) });
        buffer = buffer.slice(index);
      }

      const closeEnd = findCloseTagEndIndex(buffer, name);
      if (closeEnd === -1) break;

      const xml = buffer.slice(0, closeEnd);
      buffer = buffer.slice(closeEnd);

      const parsed = tryParseMcpToolCallXml(xml, name);
      if (parsed) out.push({ type: "tool", name: parsed.name, input: parsed.input });
      else out.push({ type: "text", text: xml });
    }

    return out;
  }

  function flush() {
    const out = [];
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
    return out;
  }

  return { pushText, flush };
}

module.exports = {
  MCP_XML_ENV,
  isMcpXmlEnabled,
  isMcpToolName,
  getMcpTools,
  getMcpToolNames,
  buildMcpXmlSystemPrompt,
  buildMcpToolCallXml,
  buildMcpToolResultXml,
  createMcpXmlStreamParser,
  tryParseMcpToolCallXml,
};
