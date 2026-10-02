import { runtime, unwrap } from "/core/runtime.js"
import {
  registerViewPlugin,
  unregisterViewPlugin,
  viewOk,
} from "/util/view-plugin.js"
import markdownit from "/widgets/markdown-it.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function getFilename(path) {
  return (
    String(path || "")
      .split("/")
      .pop() || ""
  )
}

function hasFrontmatter(source) {
  return source.startsWith("---\n") || source.startsWith("---\r\n")
}

function splitFrontmatter(source) {
  if (!hasFrontmatter(source)) return { frontmatter: null, body: source }

  const newline = source.startsWith("---\r\n") ? "\r\n" : "\n"
  const contentStart = 3 + newline.length
  const closingMarker = `${newline}---`
  const closeIndex = source.indexOf(closingMarker, contentStart)
  if (closeIndex < 0) return { frontmatter: null, body: source }

  const bodyStart = closeIndex + closingMarker.length
  const body = source.startsWith("\r\n", bodyStart)
    ? source.slice(bodyStart + 2)
    : source.startsWith("\n", bodyStart)
      ? source.slice(bodyStart + 1)
      : source.slice(bodyStart)

  return {
    frontmatter: source.slice(contentStart, closeIndex),
    body,
  }
}

function unquoteFrontmatterValue(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"'))
    return trimmed.slice(1, -1)
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1)
  return trimmed
}

function parseFrontmatter(frontmatter) {
  const entries = []
  let currentEntry = null

  for (const line of frontmatter.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue

    const listItemMatch = line.match(/^\s+-\s*(.*)$/)
    if (listItemMatch && currentEntry) {
      if (!Array.isArray(currentEntry.value))
        currentEntry.value = currentEntry.value ? [currentEntry.value] : []
      currentEntry.value.push(unquoteFrontmatterValue(listItemMatch[1]))
      continue
    }

    const separator = line.indexOf(":")
    if (separator <= 0) {
      entries.push({ key: line.trim(), value: "" })
      currentEntry = null
      continue
    }

    const key = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    const inlineList = rawValue.match(/^\[(.*)\]$/)
    const value = inlineList
      ? inlineList[1]
          .split(",")
          .map((item) => unquoteFrontmatterValue(item))
          .filter((item) => item.length > 0)
      : unquoteFrontmatterValue(rawValue)

    currentEntry = { key, value }
    entries.push(currentEntry)
  }

  return entries
}

function renderFrontmatter(frontmatter) {
  const details = document.createElement("details")
  details.open = true
  details.setAttribute("data-element", "frontmatter")

  const summary = document.createElement("summary")
  summary.textContent = "Frontmatter"
  details.append(summary)

  const entries = parseFrontmatter(frontmatter)
  if (entries.length === 0) {
    const pre = document.createElement("pre")
    pre.textContent = frontmatter
    details.append(pre)
    return details
  }

  const table = document.createElement("table")
  const tbody = document.createElement("tbody")
  table.append(tbody)

  for (const entry of entries) {
    const row = document.createElement("tr")
    const keyCell = document.createElement("th")
    const valueCell = document.createElement("td")

    keyCell.scope = "row"
    keyCell.textContent = entry.key
    valueCell.textContent = Array.isArray(entry.value)
      ? entry.value.join(", ")
      : entry.value

    row.append(keyCell, valueCell)
    tbody.append(row)
  }

  details.append(table)
  return details
}

function firstTaskMarkerTextNode(listItem) {
  const walker = document.createTreeWalker(listItem, NodeFilter.SHOW_TEXT)
  let textNode = walker.nextNode()
  while (textNode) {
    assert(
      textNode instanceof Text,
      "view-markdow task list walker returned non-text node",
    )
    const parentElement = textNode.parentElement
    assert(
      parentElement instanceof HTMLElement,
      "view-markdow task list text node missing parent element",
    )
    if (
      !parentElement.closest("code, pre") &&
      textNode.nodeValue.trim().length > 0
    )
      return textNode
    textNode = walker.nextNode()
  }
  return null
}

function renderTaskLists(root) {
  for (const listItem of root.querySelectorAll("li")) {
    const textNode = firstTaskMarkerTextNode(listItem)
    if (textNode === null) continue

    const match = textNode.nodeValue.match(/^(\s*)\[( |x|X)\]\s+/)
    if (!match) continue

    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.checked = match[2].toLowerCase() === "x"
    checkbox.disabled = true
    checkbox.setAttribute(
      "aria-label",
      checkbox.checked ? "Completed task" : "Incomplete task",
    )

    textNode.nodeValue = `${match[1]}${textNode.nodeValue.slice(match[0].length)}`
    const parentNode = textNode.parentNode
    assert(
      parentNode instanceof Node,
      "view-markdow task list text node missing parent node",
    )
    parentNode.insertBefore(checkbox, textNode)

    listItem.setAttribute("data-element", "task-list-item")
    const listElement = listItem.parentElement
    assert(
      listElement instanceof HTMLElement,
      "view-markdow task list item missing list parent",
    )
    listElement.setAttribute("data-element", "task-list")
  }
}

const markdown = markdownit({
  html: false,
  linkify: true,
  typographer: true,
})

export class ViewMarkdow extends HTMLElement {
  static get observedAttributes() {
    return ["data-source"]
  }

  constructor() {
    super()
    this.popupProps = this.popupProps || {}
    this.path = ""
    this.articleElement = null
    this.pathOutput = null
    this.statusOutput = null
  }

  connectedCallback() {
    registerViewPlugin(this, this.createViewPluginMethods())
    if (this.dataset.ready) return
    this.dataset.ready = "1"
    this.style.display = "contents"
    this.path = String(
      this.popupProps?.path || this.getAttribute("data-source") || "",
    ).trim()
    assert(this.path, "view-markdow requires data-source")

    this.innerHTML = `
      <article class="prose" data-element="markdown"></article>
      <footer>
        <output data-element="path"></output>
        <output data-element="status">Loading...</output>
      </footer>
    `

    this.articleElement = this.querySelector('[data-element="markdown"]')
    this.pathOutput = this.querySelector('[data-element="path"]')
    this.statusOutput = this.querySelector('[data-element="status"]')

    assert(
      this.articleElement instanceof HTMLElement,
      "view-markdow missing article element",
    )
    assert(
      this.pathOutput instanceof HTMLOutputElement,
      "view-markdow missing path output",
    )
    assert(
      this.statusOutput instanceof HTMLOutputElement,
      "view-markdow missing status output",
    )

    this.pathOutput.textContent = this.path
    void this.load()
  }

  disconnectedCallback() {
    void unregisterViewPlugin(this)
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return
    if (name !== "data-source") return

    this.path = String(newValue || "").trim()
    if (this.pathOutput) this.pathOutput.textContent = this.path
    if (this.dataset.ready) void this.load()
  }

  createViewPluginMethods() {
    return {
      reload: async () => {
        await this.reload()
        return viewOk()
      },
    }
  }

  setStatus(text, tone = null) {
    assert(
      this.statusOutput instanceof HTMLOutputElement,
      "view-markdow status output is not initialized",
    )
    this.statusOutput.textContent = text
    this.statusOutput.classList.remove(
      "accent",
      "success",
      "warning",
      "danger",
      "info",
    )
    if (tone) this.statusOutput.classList.add(tone)
  }

  async load() {
    assert(
      this.articleElement instanceof HTMLElement,
      "view-markdow article element is not initialized",
    )
    assert(this.path.length > 0, "view-markdow requires data-source")

    this.setStatus("Loading...", "info")
    try {
      const source = unwrap(await runtime.invoke("fs/fs::read-text", this.path))
      const { frontmatter, body } = splitFrontmatter(source)
      this.articleElement.innerHTML = markdown.render(body)
      renderTaskLists(this.articleElement)
      if (frontmatter !== null)
        this.articleElement.prepend(renderFrontmatter(frontmatter))
      this.setStatus(`Rendered ${getFilename(this.path)}`, "success")
    } catch (error) {
      this.articleElement.textContent = ""
      this.setStatus(`Error: ${error?.message || error}`, "danger")
      console.error("view-markdow load failed:", error)
    }
  }

  async reload() {
    await this.load()
  }
}

if (!customElements.get("view-markdow")) {
  customElements.define("view-markdow", ViewMarkdow)
}
