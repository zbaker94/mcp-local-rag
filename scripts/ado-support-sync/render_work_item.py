#!/usr/bin/env python3
"""Render an Azure DevOps work item (fields json + comments json) to markdown.

Usage: render_work_item.py <work-item.json> <comments.json> <out.md>

Generic over work item type — the H1 uses the item's actual WorkItemType.
Only fields present on the item are emitted, so it works for any type.
"""
import html
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


class _Strip(HTMLParser):
    def __init__(self):
        super().__init__()
        self.out = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        if tag in ("br", "p", "div", "li", "tr"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1
        if tag in ("p", "div", "li", "tr", "ul", "ol", "table"):
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def strip_html(s):
    if not s:
        return ""
    p = _Strip()
    p.feed(s)
    text = html.unescape("".join(p.out))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def disp(v):
    if isinstance(v, dict):
        return v.get("displayName") or v.get("uniqueName") or ""
    return v if v is not None else ""


def date(v):
    return (v or "")[:10]


wi = json.loads(Path(sys.argv[1]).read_text())
cpath = Path(sys.argv[2])
comments = json.loads(cpath.read_text()).get("comments", []) if cpath.exists() else []
f = wi.get("fields", {})
wid = wi.get("id")
wtype = f.get("System.WorkItemType", "Work Item")

lines = [f"# {wtype} {wid} — {f.get('System.Title', '(untitled)')}", ""]

# Metadata: (label, field-ref). Rendered only when present.
META = [
    ("Type", "System.WorkItemType"),
    ("State", "System.State"),
    ("Reason", "System.Reason"),
    ("Area path", "System.AreaPath"),
    ("Iteration", "System.IterationPath"),
    ("Assigned to", "System.AssignedTo"),
    ("Created by", "System.CreatedBy"),
    ("Created", "System.CreatedDate"),
    ("Changed", "System.ChangedDate"),
    ("Closed", "Microsoft.VSTS.Common.ClosedDate"),
    ("Priority", "Microsoft.VSTS.Common.Priority"),
    ("Severity", "Microsoft.VSTS.Common.Severity"),
    ("Tags", "System.Tags"),
]
DATE_FIELDS = {"System.CreatedDate", "System.ChangedDate", "Microsoft.VSTS.Common.ClosedDate"}
PERSON_FIELDS = {"System.AssignedTo", "System.CreatedBy"}
for label, ref in META:
    v = f.get(ref)
    if v in (None, ""):
        continue
    if ref in DATE_FIELDS:
        v = date(v)
    elif ref in PERSON_FIELDS:
        v = disp(v)
    lines.append(f"- **{label}:** {v}")

# Any Custom.* field, rendered generically.
for k in sorted(k for k in f if k.startswith("Custom.")):
    v = f[k]
    if v not in (None, ""):
        lines.append(f"- **{k.split('.', 1)[1]}:** {v}")
lines.append("")

# Links to other work items / PRs / attachments (needs $expand=relations|all).
# Work-item links resolve to "#<id>"; other links emit their URL.
def rel_label(rel, attrs):
    name = (attrs or {}).get("name")
    if name:
        return name
    return rel.rsplit(".", 1)[-1] if rel else "Link"


link_lines = []
for r in wi.get("relations", []) or []:
    url = r.get("url", "") or ""
    label = rel_label(r.get("rel", ""), r.get("attributes"))
    m = re.search(r"/workItems/(\d+)$", url)
    link_lines.append(f"- **{label}:** #{m.group(1)}" if m else f"- **{label}:** {url}")
if link_lines:
    lines += ["## Links", ""] + link_lines + [""]

for label, ref in (("Description", "System.Description"),
                   ("Acceptance criteria", "Microsoft.VSTS.Common.AcceptanceCriteria"),
                   ("Repro steps", "Microsoft.VSTS.TCM.ReproSteps")):
    body = strip_html(f.get(ref))
    if body:
        lines += [f"## {label}", "", body, ""]

lines += [f"## Comments ({len(comments)})", ""]
for c in sorted(comments, key=lambda c: c.get("createdDate", "")):  # oldest-first
    body = strip_html(c.get("text"))
    if not body:
        continue
    lines += [f"### {disp(c.get('createdBy'))} — {date(c.get('createdDate'))}", "", body, ""]

Path(sys.argv[3]).write_text("\n".join(lines) + "\n", encoding="utf-8")
