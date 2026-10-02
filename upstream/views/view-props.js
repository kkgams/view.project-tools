import { runtime, unwrap } from "/core/runtime.js"
import { registerViewPlugin, unregisterViewPlugin } from "/util/view-plugin.js"

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function stringifyJsonValue(value, label) {
    let json
    try {
        json = JSON.stringify(value)
    } catch (error) {
        throw new Error(`${label} must be JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    assert(json !== undefined, `${label} must be JSON`)
    return json
}

function cloneStringProps(input) {
    assert(input && typeof input === "object" && !Array.isArray(input), "view-props data-source must be an object")
    const props = {}
    for (const [key, value] of Object.entries(input)) {
        props[String(key)] = String(value ?? "")
    }
    return props
}

function cloneJsonProps(input) {
    assert(input && typeof input === "object" && !Array.isArray(input), "view-props data-source must be an object")
    const props = {}
    for (const [key, value] of Object.entries(input)) {
        props[String(key)] = stringifyJsonValue(value, `view-props property ${key}`)
    }
    return props
}

function resolveValueMode(props, element) {
    const mode = props.valueMode ?? element.getAttribute("data-value-mode") ?? "string"
    assert(mode === "string" || mode === "json", `view-props unknown value mode ${mode}`)
    return mode
}

function createInputElement(markup, key) {
    const template = document.createElement("template")
    template.innerHTML = markup.trim()
    assert(template.content.children.length === 1, `view-props input ${key} must contain exactly one element`)
    for (const node of template.content.childNodes) {
        assert(node.nodeType === Node.ELEMENT_NODE || String(node.textContent).trim() === "", `view-props input ${key} must contain only one element`)
    }
    const editor = template.content.firstElementChild
    const tag = editor.tagName.toLowerCase()
    assert(/^widget-input-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag), `view-props input ${key} must use a widget-input-* element`)
    return editor
}

async function loadInputTemplates(input) {
    if (input === undefined) return {}
    assert(input && typeof input === "object" && !Array.isArray(input), "view-props inputs must be an object")
    const templates = {}
    for (const [key, markup] of Object.entries(input)) {
        assert(key.length > 0, "view-props input property name must be non-empty")
        assert(typeof markup === "string" && markup.trim().length > 0, `view-props input ${key} must be non-empty HTML`)
        const editor = createInputElement(markup, key)
        const tag = editor.tagName.toLowerCase()
        const moduleName = tag.slice("widget-input-".length)
        const moduleUrl = new URL(`/widgets/inputs/${moduleName}.js`, location.origin).href
        await import(moduleUrl)
        assert(customElements.get(tag), `view-props input ${key} module did not register ${tag}`)
        templates[key] = markup
    }
    return templates
}

export class ViewProps extends HTMLElement {
    static get observedAttributes() {
        return ["data-source", "data-title", "data-value-mode"]
    }

    constructor() {
        super()
        this.formElement = null
        this.legendElement = null
        this.tableElement = null
        this.statusElement = null
        this.rowsElement = null
        this.props = {}
        this.inputTemplates = {}
        this.valueMode = "string"
    }

    connectedCallback() {
        registerViewPlugin(this)
        if (this.dataset.ready) return
        this.dataset.ready = "1"
        this.style.display = "contents"

        this.innerHTML = `
      <form data-element="form" novalidate>
        <fieldset>
          <legend data-element="legend">Properties</legend>
          <table data-element="props">
            <thead>
              <tr><th>Key</th><th>Value</th><th></th></tr>
            </thead>
            <tbody></tbody>
          </table>
        </fieldset>
        <footer>
          <output data-element="status"></output>
          <button type="button" data-action="add"><i aria-hidden="true">add</i>Add</button>
          <button type="button" data-action="cancel">Cancel</button>
          <button type="submit" data-action="save" class="accent">Save</button>
        </footer>
      </form>
    `

        this.formElement = this.querySelector('[data-element="form"]')
        this.legendElement = this.querySelector('[data-element="legend"]')
        this.tableElement = this.querySelector('[data-element="props"]')
        this.statusElement = this.querySelector('[data-element="status"]')
        this.rowsElement = this.querySelector("tbody")

        assert(this.formElement instanceof HTMLFormElement, "view-props missing form")
        assert(this.legendElement instanceof HTMLLegendElement, "view-props missing legend")
        assert(this.tableElement instanceof HTMLTableElement, "view-props missing props table")
        assert(this.statusElement instanceof HTMLOutputElement, "view-props missing status output")
        assert(this.rowsElement instanceof HTMLTableSectionElement, "view-props missing props tbody")

        this.querySelector('[data-action="add"]').addEventListener("click", () => this.addRow("", ""))
        this.querySelector('[data-action="cancel"]').addEventListener("click", async () => {
            unwrap(await runtime.call("ui.popup.close", { ok: false, cancelled: true }))
        })
        this.formElement.addEventListener("submit", async (event) => {
            event.preventDefault()
            await this.save()
        })
        this.tableElement.addEventListener("click", (event) => {
            const button = event.target.closest('button[data-action="delete-row"]')
            if (!(button instanceof HTMLButtonElement)) return
            const row = button.closest('tr[data-element="prop-row"]')
            assert(row instanceof HTMLTableRowElement, "view-props delete requires row")
            row.remove()
            if (this.rowsElement.children.length === 0) this.addRow("", "")
        })

        void this.load()
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) return
        if (!this.dataset.ready) return
        if (name === "data-source" || name === "data-title" || name === "data-value-mode") void this.load()
    }

    async load() {
        const props = this.popupProps || {}
        const title = String(props.title || this.getAttribute("data-title") || "Properties")
        this.legendElement.textContent = title
        this.valueMode = resolveValueMode(props, this)
        this.inputTemplates = await loadInputTemplates(props.inputs)
        const dataSource = this.readDataSource(props)
        this.props = this.valueMode === "json" ? cloneJsonProps(dataSource) : cloneStringProps(dataSource)
        this.renderRows()
        this.setStatus(this.valueMode === "json" ? 'Values must be JSON literals; quote strings like "text"' : "Edit string properties", "info")
    }

    readDataSource(props) {
        if (props.dataSource !== undefined) return props.dataSource
        const source = this.getAttribute("data-source")
        if (source == null || source === "") return {}
        return JSON.parse(source)
    }

    renderRows() {
        this.rowsElement.replaceChildren()
        const entries = Object.entries(this.props)
        if (entries.length === 0) {
            this.addRow("", "")
            return
        }
        for (const [key, value] of entries) this.addRow(key, value)
    }

    addRow(key, value) {
        const row = document.createElement("tr")
        row.dataset.element = "prop-row"

        const keyCell = document.createElement("td")
        const keyInput = document.createElement("input")
        keyInput.type = "text"
        keyInput.name = "prop-key"
        keyInput.value = key
        keyInput.placeholder = "key"
        keyInput.setAttribute("autocomplete", "off")
        keyInput.setAttribute("autocorrect", "off")
        keyInput.setAttribute("autocapitalize", "off")
        keyInput.spellcheck = false
        keyCell.appendChild(keyInput)
        row.appendChild(keyCell)

        const valueCell = document.createElement("td")
        const initialValue = key === "" && value === "" ? undefined : this.decodeStoredValue(value, key)
        this.mountValueEditor(valueCell, key, initialValue)
        keyInput.addEventListener("input", () => {
            const currentValue = this.readValueEditor(row, { allowInvalidJson: true })
            this.mountValueEditor(valueCell, keyInput.value.trim(), currentValue)
        })
        row.appendChild(valueCell)

        const actionsCell = document.createElement("td")
        const deleteButton = document.createElement("button")
        deleteButton.type = "button"
        deleteButton.dataset.action = "delete-row"
        const icon = document.createElement("i")
        icon.setAttribute("aria-hidden", "true")
        icon.textContent = "delete"
        deleteButton.appendChild(icon)
        actionsCell.appendChild(deleteButton)
        row.appendChild(actionsCell)

        this.rowsElement.appendChild(row)
    }

    decodeStoredValue(value, key) {
        if (this.valueMode === "string") return value
        try {
            return JSON.parse(value)
        } catch (error) {
            throw new Error(`Property ${key} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    mountValueEditor(valueCell, key, value) {
        valueCell.replaceChildren()
        const markup = this.inputTemplates[key]
        if (markup !== undefined) {
            const parsedEditor = createInputElement(markup, key)
            const tag = parsedEditor.tagName.toLowerCase()
            assert(customElements.get(tag), `view-props input ${key} custom element ${tag} is not registered`)
            const registeredEditor = document.createElement(tag)
            for (const attribute of parsedEditor.attributes) {
                registeredEditor.setAttribute(attribute.name, attribute.value)
            }
            registeredEditor.append(...[...parsedEditor.childNodes].map((node) => node.cloneNode(true)))
            assert("value" in registeredEditor, `view-props input ${key} must expose value`)
            valueCell.appendChild(registeredEditor)
            if (value !== undefined) registeredEditor.value = value
            return
        }

        const valueInput = document.createElement("input")
        valueInput.type = "text"
        valueInput.name = "prop-value"
        valueInput.value = value === undefined ? "" : this.valueMode === "json" ? stringifyJsonValue(value, `view-props property ${key}`) : String(value)
        valueInput.placeholder = this.valueMode === "json" ? "JSON value" : "value"
        valueInput.setAttribute("autocomplete", "off")
        valueInput.setAttribute("autocorrect", "off")
        valueInput.setAttribute("autocapitalize", "off")
        valueInput.spellcheck = false
        valueCell.appendChild(valueInput)
    }

    readValueEditor(row, { allowInvalidJson = false } = {}) {
        const valueCell = row.children[1]
        assert(valueCell instanceof HTMLTableCellElement, "view-props row missing value cell")
        const editor = valueCell.firstElementChild
        assert(editor instanceof HTMLElement, "view-props row missing value editor")
        if (editor.tagName.toLowerCase().startsWith("widget-input-")) return editor.value
        assert(editor instanceof HTMLInputElement && editor.name === "prop-value", "view-props row has invalid value editor")
        if (this.valueMode === "string") return editor.value
        try {
            return JSON.parse(editor.value)
        } catch (error) {
            if (allowInvalidJson) return undefined
            throw new Error(`Property value must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    collectProps() {
        const props = {}
        const seen = new Set()
        for (const row of this.rowsElement.querySelectorAll('tr[data-element="prop-row"]')) {
            const keyInput = row.querySelector('input[name="prop-key"]')
            assert(keyInput instanceof HTMLInputElement, "view-props row missing key input")
            const key = keyInput.value.trim()
            if (!key) continue
            if (seen.has(key)) throw new Error(`Duplicate property key ${key}`)
            seen.add(key)
            const value = this.readValueEditor(row)
            assert(value !== undefined, `Property ${key} requires a value`)
            props[key] = value
        }
        return props
    }

    async save() {
        try {
            const data = this.collectProps()
            unwrap(
                await runtime.call("ui.popup.close", {
                    ok: true,
                    cancelled: false,
                    data,
                }),
            )
        } catch (error) {
            this.setStatus(`Error: ${error.message}`, "danger")
        }
    }

    setStatus(text, tone = "") {
        this.statusElement.textContent = text
        this.statusElement.className = ""
        if (tone) this.statusElement.classList.add(tone)
    }

    disconnectedCallback() {
        void unregisterViewPlugin(this)
    }
}

if (!customElements.get("view-props")) {
    customElements.define("view-props", ViewProps)
}
