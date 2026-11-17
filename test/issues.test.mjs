import assert from "node:assert/strict"
import { readdir, readFile, stat } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

const root = new URL("../", import.meta.url)
const project = JSON.parse(await readFile(new URL("gams.json", root), "utf8"))
const source = await readFile(new URL("src/view.issues/views/view-issues.js", root), "utf8")

function createView() {
    const context = vm.createContext({
        HTMLElement: class {
            getAttribute() {
                return null
            }
        },
        customElements: { get: () => true },
        runtime: {
            async invoke(target, path) {
                const file = new URL(path, root)
                if (target === "fs/fs::list")
                    return {
                        ok: (await readdir(file, { withFileTypes: true })).map((entry) => ({
                            name: entry.name,
                            type: entry.isDirectory() ? "directory" : "regular-file",
                        })),
                    }
                if (target === "fs/fs::read-text") return { ok: await readFile(file, "utf8") }
                assert.equal(target, "fs/fs::stat")
                const value = await stat(file)
                return { ok: { mtime: value.mtimeMs, ctime: value.ctimeMs, atime: value.atimeMs } }
            },
        },
        unwrap(result) {
            if (Object.hasOwn(result, "ok")) return result.ok
            throw new Error(result.err)
        },
    })
    vm.runInContext(
        source.replace(/^import\s+[\s\S]*?from\s+"[^"]+"\s*\n/gm, "").replace("export class ", "class "),
        context,
    )
    const view = vm.runInContext("new ViewIssues()", context)
    view.config = structuredClone(project.ui.views["view-issues"].config)
    return view
}

test("the local Project Issues configuration accepts its authored sort direction", () => {
    const view = createView()
    view.readConfig()
    const sorted = view.sortIssues([
        { path: "older.md", stat: { mtime: 1 } },
        { path: "newer.md", stat: { mtime: 2 } },
    ])
    assert.deepEqual(
        Array.from(sorted, (item) => item.path),
        ["newer.md", "older.md"],
    )
})

test("the local Project Issues source contains loadable issue documents", async () => {
    const view = createView()
    view.readConfig()
    const statuses = []
    view.setStatus = (text) => statuses.push(text)
    view.renderBoard = () => {}
    await view.refresh()
    assert.ok(view.issues.length > 0)
    assert.equal(statuses.at(-1), `${view.issues.length} issue files`)
    for (const issue of view.issues) {
        assert.equal(typeof issue.frontmatter.title, "string")
        assert.equal(typeof issue.frontmatter.description, "string")
        assert.ok(view.filterConfig.status.includes(issue.frontmatter.status))
    }
})
