import { runtime, unwrap } from "/core/runtime.js"
import {
  registerViewPlugin,
  unregisterViewPlugin,
  viewOk,
} from "/util/view-plugin.js"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const BUILTIN_TIME_SORTS = new Set(["mtime", "ctime", "atime"])
const SORT_DIRECTIONS = new Set(["asc", "dsc"])
const DND_ALL_VALUES = "*"

function normalizePath(path) {
  const raw = String(path || ".").trim()
  if (!raw || raw === ".") return "."
  const parts = raw.split("/").filter(Boolean)
  return parts.join("/") || "."
}

function joinPath(basePath, name) {
  const base = normalizePath(basePath)
  if (base === ".") return String(name)
  return `${base}/${name}`
}

function getExtension(path) {
  const name =
    String(path || "")
      .split("/")
      .pop() || ""
  const parts = name.split(".")
  if (parts.length <= 1) return ""
  return parts.pop().toLowerCase()
}

function parseScalar(rawValue) {
  const value = String(rawValue).trim()
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseFrontmatterValue(rawValue) {
  const value = String(rawValue).trim()
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(",").map((part) => parseScalar(part))
  }
  return parseScalar(value)
}

function parseIssueMarkdown(path, text) {
  assert(
    text.startsWith("---\n") || text.startsWith("---\r\n"),
    `issue file ${path} must start with frontmatter`,
  )
  const newline = text.startsWith("---\r\n") ? "\r\n" : "\n"
  const closeMarker = `${newline}---${newline}`
  const closeIndex = text.indexOf(closeMarker, 3)
  assert(
    closeIndex >= 0,
    `issue file ${path} missing closing frontmatter marker`,
  )

  const frontmatterText = text.slice(3 + newline.length, closeIndex)
  const body = text.slice(closeIndex + closeMarker.length)
  const frontmatter = {}

  for (const line of frontmatterText.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf(":")
    assert(
      separator > 0,
      `issue file ${path} has invalid frontmatter line: ${line}`,
    )
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1)
    assert(key.length > 0, `issue file ${path} has empty frontmatter key`)
    frontmatter[key] = parseFrontmatterValue(value)
  }

  assert(
    typeof frontmatter.title === "string" &&
      frontmatter.title.trim().length > 0,
    `issue file ${path} requires string frontmatter title`,
  )
  assert(
    typeof frontmatter.description === "string",
    `issue file ${path} requires string frontmatter description`,
  )

  return { path, text, frontmatter, body }
}

function updateFrontmatterScalar(text, path, field, value) {
  assert(
    text.startsWith("---\n") || text.startsWith("---\r\n"),
    `issue file ${path} must start with frontmatter`,
  )
  const newline = text.startsWith("---\r\n") ? "\r\n" : "\n"
  const closeMarker = `${newline}---${newline}`
  const closeIndex = text.indexOf(closeMarker, 3)
  assert(
    closeIndex >= 0,
    `issue file ${path} missing closing frontmatter marker`,
  )

  const frontmatterStart = 3 + newline.length
  const frontmatterText = text.slice(frontmatterStart, closeIndex)
  const lines = frontmatterText.split(/\r?\n/)
  const fieldPrefix = `${field}:`
  let replaced = false
  const nextLines = lines.map((line) => {
    if (line.trimStart().startsWith(fieldPrefix)) {
      replaced = true
      return `${field}: ${value}`
    }
    return line
  })
  if (!replaced) nextLines.push(`${field}: ${value}`)

  return `${text.slice(0, frontmatterStart)}${nextLines.join(newline)}${text.slice(closeIndex)}`
}

function fieldValues(issue, field) {
  const value = issue.frontmatter[field]
  if (Array.isArray(value)) return value.map(String)
  if (value === undefined || value === null) return []
  return [String(value)]
}

function renderMarkdownSummary(body) {
  const trimmed = String(body || "").trim()
  if (!trimmed) return ""
  const firstBlock = trimmed.split(/\n\s*\n/)[0]
  return firstBlock
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, ""))
    .join(" ")
    .trim()
}

function normalizeSortDirection(value, key) {
  assert(
    SORT_DIRECTIONS.has(value),
    `view-issues sort.${key} must be "asc", "dsc", or an enum array`,
  )
  return value
}

function addDndValue(dndConfig, field, value, filterConfig) {
  assert(
    Object.hasOwn(filterConfig, field),
    `view-issues config.dnd.${field} must reference a configured filter`,
  )
  assert(
    typeof value === "string" && value.length > 0,
    `view-issues config.dnd.${field} values must be non-empty strings`,
  )
  if (value === DND_ALL_VALUES) {
    dndConfig[field] = DND_ALL_VALUES
    return
  }
  assert(
    filterConfig[field].includes(value),
    `view-issues config.dnd.${field} value ${value} must exist in config.filter.${field}`,
  )
  if (dndConfig[field] === DND_ALL_VALUES) return
  if (!Array.isArray(dndConfig[field])) dndConfig[field] = []
  dndConfig[field].push(value)
}

function normalizeDndConfig(rawDndConfig, filterConfig) {
  const dndConfig = {}
  if (rawDndConfig === undefined) return dndConfig

  if (Array.isArray(rawDndConfig)) {
    assert(rawDndConfig.length > 0, "view-issues config.dnd must not be empty")
    for (const token of rawDndConfig) {
      assert(
        typeof token === "string" && token.length > 0,
        "view-issues config.dnd entries must be non-empty strings",
      )
      const separator = token.indexOf(":")
      assert(
        separator > 0 && separator < token.length - 1,
        `view-issues config.dnd entry ${token} must use field:value`,
      )
      addDndValue(
        dndConfig,
        token.slice(0, separator),
        token.slice(separator + 1),
        filterConfig,
      )
    }
    return dndConfig
  }

  assert(
    rawDndConfig && typeof rawDndConfig === "object",
    "view-issues config.dnd must be an object or field:value array when present",
  )
  for (const [field, values] of Object.entries(rawDndConfig)) {
    if (values === DND_ALL_VALUES) {
      addDndValue(dndConfig, field, DND_ALL_VALUES, filterConfig)
      continue
    }
    assert(
      Array.isArray(values),
      `view-issues config.dnd.${field} must be "*" or an array`,
    )
    assert(
      values.length > 0,
      `view-issues config.dnd.${field} must not be empty`,
    )
    for (const value of values)
      addDndValue(dndConfig, field, value, filterConfig)
  }
  return dndConfig
}

function comparePrimitive(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a ?? "").localeCompare(String(b ?? ""))
}

export class ViewIssues extends HTMLElement {
  static get observedAttributes() {
    return ["data-source"]
  }

  constructor() {
    super()
    this.sourcePath = ""
    this.filterConfig = null
    this.sortConfig = null
    this.dndConfig = null
    this.openViewTag = ""
    this.activeFilter = ""
    this.activeSort = ""
    this.issues = []
    this.headerControlsElement = null
    this.filterSelect = null
    this.sortSelect = null
    this.tableElement = null
    this.statusOutput = null
    this.pointerDrag = null
    this._headerControlsElement = null
  }

  connectedCallback() {
    registerViewPlugin(this, this.createViewPluginMethods())
    if (this.dataset.ready) return
    this.dataset.ready = "1"
    this.style.display = "contents"

    this.readConfig()

    this.innerHTML = `
      <table data-layout="separate" data-element="issue-board">
        <thead></thead>
        <tbody></tbody>
      </table>
      <footer>
        <output data-element="status">Loading...</output>
      </footer>
    `

    this.tableElement = this.querySelector('[data-element="issue-board"]')
    this.statusOutput = this.querySelector('[data-element="status"]')

    assert(
      this.tableElement instanceof HTMLTableElement,
      "view-issues missing issue board table",
    )
    assert(
      this.statusOutput instanceof HTMLOutputElement,
      "view-issues missing status output",
    )

    this._mountHeaderControls()
    assert(
      this._headerControlsElement instanceof HTMLElement,
      "view-issues missing header controls element",
    )
    this.headerControlsElement = this._headerControlsElement
    this.filterSelect = this._headerControlsElement.querySelector(
      '[data-field="filter"]',
    )
    this.sortSelect = this._headerControlsElement.querySelector(
      '[data-field="sort"]',
    )

    assert(
      this.headerControlsElement instanceof HTMLElement,
      "view-issues missing controls element",
    )
    assert(
      this.filterSelect instanceof HTMLSelectElement,
      "view-issues missing filter select",
    )
    assert(
      this.sortSelect instanceof HTMLSelectElement,
      "view-issues missing sort select",
    )

    this.renderControls()

    this.filterSelect.addEventListener("change", () => {
      this.activeFilter = this.filterSelect.value
      this.renderBoard()
    })
    this.sortSelect.addEventListener("change", () => {
      this.activeSort = this.sortSelect.value
      this.renderBoard()
    })
    void this.refresh()
  }

  disconnectedCallback() {
    if (this.pointerDrag)
      this.cleanupPointerDrag(
        this.pointerDrag,
        this.pointerDrag.card,
        this.pointerDrag.pointerId,
      )
    this._unmountHeaderControls()
    void unregisterViewPlugin(this)
  }

  createHeaderControlsElement() {
    const controls = document.createElement("div")
    controls.dataset.element = "header-controls"
    controls.setAttribute("slot", "header-controls")
    controls.innerHTML = `
      <label>
        Filter
        <select data-field="filter"></select>
      </label>
      <label>
        Sort
        <select data-field="sort"></select>
      </label>
    `
    return controls
  }

  _mountHeaderControls() {
    if (!this.parentElement || this._headerControlsElement) return
    this._headerControlsElement = this.createHeaderControlsElement()
    this.parentElement.appendChild(this._headerControlsElement)
  }

  _unmountHeaderControls() {
    if (this._headerControlsElement?.parentElement)
      this._headerControlsElement.remove()
    this._headerControlsElement = null
    this.headerControlsElement = null
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return
    if (name === "data-source") {
      this.sourcePath = normalizePath(newValue || "")
      if (this.dataset.ready) void this.refresh()
    }
  }

  createViewPluginMethods() {
    return {
      reload: async () => {
        await this.refresh()
        return viewOk(true)
      },
    }
  }

  readConfig() {
    const config = this.config
    assert(
      config && typeof config === "object" && !Array.isArray(config),
      "view-issues requires config object",
    )
    assert(
      config.filter &&
        typeof config.filter === "object" &&
        !Array.isArray(config.filter),
      "view-issues config.filter must be an object",
    )
    assert(
      config.sort &&
        typeof config.sort === "object" &&
        !Array.isArray(config.sort),
      "view-issues config.sort must be an object",
    )
    assert(
      config.dnd === undefined ||
        (config.dnd && typeof config.dnd === "object"),
      "view-issues config.dnd must be an object or field:value array when present",
    )
    assert(
      typeof config.open === "string" && config.open.trim().length > 0,
      "view-issues config.open must be a view tag string",
    )

    this.filterConfig = config.filter
    this.sortConfig = config.sort
    this.dndConfig = null
    this.openViewTag = config.open.trim()

    for (const [key, values] of Object.entries(this.filterConfig)) {
      assert(
        Array.isArray(values),
        `view-issues config.filter.${key} must be an array`,
      )
      assert(
        values.length > 0,
        `view-issues config.filter.${key} must not be empty`,
      )
      for (const value of values)
        assert(
          typeof value === "string" && value.length > 0,
          `view-issues config.filter.${key} values must be non-empty strings`,
        )
    }

    for (const [key, value] of Object.entries(this.sortConfig)) {
      if (Array.isArray(value)) {
        assert(
          value.length > 0,
          `view-issues config.sort.${key} enum order must not be empty`,
        )
        for (const item of value)
          assert(
            typeof item === "string" && item.length > 0,
            `view-issues config.sort.${key} enum values must be non-empty strings`,
          )
      } else {
        assert(
          BUILTIN_TIME_SORTS.has(key),
          `view-issues config.sort.${key} direction sort is only supported for mtime, ctime, or atime`,
        )
        normalizeSortDirection(value, key)
      }
    }

    this.dndConfig = normalizeDndConfig(config.dnd, this.filterConfig)

    const attrSource = this.getAttribute("data-source")
    const configSource = config.defaultSource
    assert(
      (typeof attrSource === "string" && attrSource.trim().length > 0) ||
        (typeof configSource === "string" && configSource.trim().length > 0),
      "view-issues requires data-source or config.defaultSource",
    )
    this.sourcePath = normalizePath(attrSource || configSource)

    this.activeFilter = Object.keys(this.filterConfig)[0]
    this.activeSort = Object.keys(this.sortConfig)[0]
    assert(
      this.activeFilter,
      "view-issues config.filter must define at least one filter",
    )
    assert(
      this.activeSort,
      "view-issues config.sort must define at least one sort",
    )
  }

  renderControls() {
    this.filterSelect.replaceChildren(
      ...Object.keys(this.filterConfig).map((key) => {
        const option = document.createElement("option")
        option.value = key
        option.textContent = key
        return option
      }),
    )
    this.sortSelect.replaceChildren(
      ...Object.keys(this.sortConfig).map((key) => {
        const option = document.createElement("option")
        option.value = key
        option.textContent = key
        return option
      }),
    )
    this.filterSelect.value = this.activeFilter
    this.sortSelect.value = this.activeSort
  }

  setStatus(text, tone = null) {
    assert(
      this.statusOutput instanceof HTMLOutputElement,
      "view-issues missing status output",
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

  async callFs(method, ...input) {
    return unwrap(await runtime.invoke(`fs/fs::${method}`, ...input))
  }

  async refresh() {
    this.setStatus(`Loading ${this.sourcePath}...`, "info")
    const files = await this.callFs("list", this.sourcePath)
    assert(Array.isArray(files), "fs.list must return an array")

    const markdownFiles = files
      .filter(
        (entry) =>
          entry.type === "regular-file" &&
          ["md", "markdown"].includes(getExtension(entry.name)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))

    this.issues = await Promise.all(
      markdownFiles.map(async (entry) => {
        const path = joinPath(this.sourcePath, entry.name)
        const [text, stat] = await Promise.all([
          this.callFs("read-text", path),
          this.callFs("stat", path),
        ])
        const issue = parseIssueMarkdown(path, text)
        issue.stat = stat
        return issue
      }),
    )

    this.renderBoard()
    this.setStatus(`${this.issues.length} issue files`, "success")
  }

  sortIssues(issues) {
    const sortKey = this.activeSort
    const sortRule = this.sortConfig[sortKey]

    if (Array.isArray(sortRule)) {
      const order = new Map(sortRule.map((value, index) => [value, index]))
      return [...issues].sort((a, b) => {
        const aValue = fieldValues(a, sortKey)[0]
        const bValue = fieldValues(b, sortKey)[0]
        const aIndex = order.has(aValue)
          ? order.get(aValue)
          : Number.POSITIVE_INFINITY
        const bIndex = order.has(bValue)
          ? order.get(bValue)
          : Number.POSITIVE_INFINITY
        if (aIndex !== bIndex) return aIndex - bIndex
        return a.path.localeCompare(b.path)
      })
    }

    const direction = normalizeSortDirection(sortRule, sortKey)
    return [...issues].sort((a, b) => {
      assert(
        Object.hasOwn(a.stat, sortKey),
        `fs.stat result for ${a.path} is missing ${sortKey}`,
      )
      assert(
        Object.hasOwn(b.stat, sortKey),
        `fs.stat result for ${b.path} is missing ${sortKey}`,
      )
      const result = comparePrimitive(a.stat[sortKey], b.stat[sortKey])
      return direction === "asc" ? result : -result
    })
  }

  canDrag(field, value) {
    const values = this.dndConfig[field]
    return (
      values === DND_ALL_VALUES ||
      (Array.isArray(values) && values.includes(value))
    )
  }

  canDragIssue(issue) {
    const values = fieldValues(issue, this.activeFilter)
    return values.length === 1 && this.canDrag(this.activeFilter, values[0])
  }

  columnCellFromDragEvent(event) {
    const tableRect = this.tableElement.getBoundingClientRect()
    if (
      event.clientX >= tableRect.left &&
      event.clientX <= tableRect.right &&
      event.clientY >= tableRect.top &&
      event.clientY <= tableRect.bottom
    ) {
      const cells = [
        ...this.tableElement.querySelectorAll('td[data-dnd="drop-target"]'),
      ]
      for (const cell of cells) {
        const rect = cell.getBoundingClientRect()
        if (event.clientX >= rect.left && event.clientX <= rect.right)
          return cell
      }
    }

    const pointed = document.elementFromPoint(event.clientX, event.clientY)
    const pointedCell = pointed?.closest('td[data-dnd="drop-target"]')
    if (
      pointedCell instanceof HTMLTableCellElement &&
      this.tableElement.contains(pointedCell)
    )
      return pointedCell

    return null
  }

  clearDropTargetHighlight() {
    this.tableElement
      .querySelectorAll('td[data-dnd="drop-target"][aria-selected="true"]')
      .forEach((cell) => {
        cell.removeAttribute("aria-selected")
      })
  }

  createPointerDragGhost(card, event) {
    const rect = card.getBoundingClientRect()
    const ghost = card.cloneNode(true)
    ghost.dataset.dragGhost = "true"
    ghost.removeAttribute("aria-grabbed")
    ghost.style.position = "fixed"
    ghost.style.left = `${event.clientX + 12}px`
    ghost.style.top = `${event.clientY + 12}px`
    ghost.style.width = `${rect.width}px`
    ghost.style.margin = "0"
    ghost.style.pointerEvents = "none"
    ghost.style.zIndex = "100000"
    ghost.style.opacity = "0.85"
    document.body.appendChild(ghost)
    return ghost
  }

  updatePointerDragGhost(drag, event) {
    if (!drag.ghost) return
    drag.ghost.style.left = `${event.clientX + 12}px`
    drag.ghost.style.top = `${event.clientY + 12}px`
  }

  removePointerDragGhost(drag) {
    if (drag?.ghost?.parentElement) drag.ghost.remove()
  }

  cleanupPointerDrag(drag, card, pointerId) {
    this.pointerDrag = null
    document.documentElement.style.userSelect = drag.previousUserSelect
    this.removePointerDragGhost(drag)
    this.clearDropTargetHighlight()
    card.removeAttribute("aria-grabbed")
    if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId)
  }

  startPointerDrag(event, issue, card) {
    if (event.button !== 0) return
    const values = fieldValues(issue, this.activeFilter)
    assert(
      values.length === 1,
      `view-issues pointer drag only supports scalar ${this.activeFilter} values`,
    )
    assert(
      this.canDrag(this.activeFilter, values[0]),
      `view-issues cannot pointer-drag issue ${issue.path} from ${this.activeFilter}:${values[0]}`,
    )

    event.preventDefault()
    const previousUserSelect = document.documentElement.style.userSelect
    document.documentElement.style.userSelect = "none"
    card.setPointerCapture(event.pointerId)
    this.pointerDrag = {
      pointerId: event.pointerId,
      path: issue.path,
      field: this.activeFilter,
      from: values[0],
      startX: event.clientX,
      startY: event.clientY,
      previousUserSelect,
      active: false,
      card,
      ghost: null,
    }
  }

  updatePointerDrag(event, card) {
    const drag = this.pointerDrag
    if (!drag || drag.card !== card || drag.pointerId !== event.pointerId)
      return
    event.preventDefault()

    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.active && Math.hypot(dx, dy) >= 4) {
      drag.active = true
      drag.ghost = this.createPointerDragGhost(card, event)
      card.setAttribute("aria-grabbed", "true")
    }
    if (!drag.active) return

    this.updatePointerDragGhost(drag, event)
    const cell = this.columnCellFromDragEvent(event)
    this.clearDropTargetHighlight()
    if (cell) cell.setAttribute("aria-selected", "true")
  }

  finishPointerDrag(event, card) {
    const drag = this.pointerDrag
    if (!drag || drag.card !== card || drag.pointerId !== event.pointerId)
      return
    event.preventDefault()

    const cell = this.columnCellFromDragEvent(event)

    this.cleanupPointerDrag(drag, card, event.pointerId)

    if (!drag.active || !cell) return
    assert(
      cell.dataset.field === drag.field,
      `view-issues pointer drop field ${cell.dataset.field} does not match drag field ${drag.field}`,
    )
    assert(
      typeof cell.dataset.value === "string" && cell.dataset.value.length > 0,
      "view-issues pointer drop target missing value",
    )
    void this.moveIssue(drag.path, drag.field, cell.dataset.value)
  }

  cancelPointerDrag(event, card) {
    const drag = this.pointerDrag
    if (!drag || drag.card !== card || drag.pointerId !== event.pointerId)
      return
    this.cleanupPointerDrag(drag, card, event.pointerId)
  }

  async openIssue(issue) {
    assert(
      issue && typeof issue === "object",
      "view-issues openIssue requires issue record",
    )
    assert(
      typeof issue.path === "string" && issue.path.length > 0,
      "view-issues issue record missing path",
    )
    assert(
      typeof this.openViewTag === "string" && this.openViewTag.length > 0,
      "view-issues config.open must be initialized",
    )

    const payload = unwrap(
      await runtime.call("ui.popup.open", {
        title: issue.frontmatter.title,
        size: "large",
        tag: this.openViewTag,
        props: {
          path: issue.path,
          issue,
        },
      }),
    )

    if (payload?.reload) await this.refresh()
  }

  async moveIssue(issuePath, field, targetValue) {
    assert(
      field === this.activeFilter,
      `view-issues drop field ${field} does not match active filter ${this.activeFilter}`,
    )
    assert(
      this.canDrag(field, targetValue),
      `view-issues cannot drop into ${field}:${targetValue}`,
    )
    const issue = this.issues.find((candidate) => candidate.path === issuePath)
    assert(issue, `view-issues unknown dragged issue ${issuePath}`)
    const values = fieldValues(issue, field)
    assert(
      values.length === 1,
      `view-issues drag/drop only supports scalar ${field} values`,
    )
    assert(
      this.canDrag(field, values[0]),
      `view-issues cannot drag issue ${issuePath} from ${field}:${values[0]}`,
    )
    if (values[0] === targetValue) return

    const nextText = updateFrontmatterScalar(
      issue.text,
      issue.path,
      field,
      targetValue,
    )
    await this.callFs("write-text", issue.path, nextText)
    await this.refresh()
    this.setStatus(
      `Moved ${issue.frontmatter.title} to ${field}:${targetValue}`,
      "success",
    )
  }

  renderBoard() {
    const columns = this.filterConfig[this.activeFilter]
    assert(
      Array.isArray(columns),
      `view-issues active filter ${this.activeFilter} is not configured`,
    )

    const thead = this.tableElement.querySelector("thead")
    const tbody = this.tableElement.querySelector("tbody")
    assert(
      thead instanceof HTMLTableSectionElement,
      "view-issues missing table head",
    )
    assert(
      tbody instanceof HTMLTableSectionElement,
      "view-issues missing table body",
    )

    const groups = new Map(columns.map((column) => [column, []]))
    for (const issue of this.sortIssues(this.issues)) {
      for (const value of fieldValues(issue, this.activeFilter)) {
        if (groups.has(value)) groups.get(value).push(issue)
      }
    }

    const headerRow = document.createElement("tr")
    for (const column of columns) {
      const th = document.createElement("th")
      th.scope = "col"
      th.textContent = `${column} (${groups.get(column).length})`
      headerRow.appendChild(th)
    }
    thead.replaceChildren(headerRow)

    const bodyRow = document.createElement("tr")
    for (const column of columns) {
      const td = document.createElement("td")
      td.dataset.field = this.activeFilter
      td.dataset.value = column
      if (this.canDrag(this.activeFilter, column))
        td.dataset.dnd = "drop-target"
      for (const issue of groups.get(column))
        td.appendChild(this.createIssueCard(issue))
      bodyRow.appendChild(td)
    }
    tbody.replaceChildren(bodyRow)
  }

  createIssueCard(issue) {
    const card = document.createElement("blockquote")
    card.dataset.element = "issue-card"
    card.dataset.source = issue.path
    card.dataset.field = this.activeFilter
    card.dataset.value = fieldValues(issue, this.activeFilter).join(",")
    card.addEventListener("dblclick", async (event) => {
      event.preventDefault()
      await this.openIssue(issue)
    })

    if (this.canDragIssue(issue)) {
      card.dataset.draggable = "true"
      card.addEventListener("pointerdown", (event) =>
        this.startPointerDrag(event, issue, card),
      )
      card.addEventListener("pointermove", (event) =>
        this.updatePointerDrag(event, card),
      )
      card.addEventListener("pointerup", (event) =>
        this.finishPointerDrag(event, card),
      )
      card.addEventListener("pointercancel", (event) =>
        this.cancelPointerDrag(event, card),
      )
    }

    const title = document.createElement("header")
    title.textContent = issue.frontmatter.title

    const description = document.createElement("p")
    description.textContent = issue.frontmatter.description

    const footer = document.createElement("footer")
    const path = document.createElement("output")
    path.textContent = issue.path
    footer.appendChild(path)

    const bodySummary = renderMarkdownSummary(issue.body)
    if (bodySummary) {
      const summary = document.createElement("p")
      summary.textContent = bodySummary
      card.append(title, description, summary, footer)
    } else {
      card.append(title, description, footer)
    }

    return card
  }
}

if (!customElements.get("view-issues")) {
  customElements.define("view-issues", ViewIssues)
}
