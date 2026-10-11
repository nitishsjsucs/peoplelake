"""Pinned dataset digests. macOS and ubuntu CI must produce these bytes exactly.

Regenerate with `peoplelake generate --profile <p>` after an intentional generator change, then
update both the pin and the committed oracle seeds (`peoplelake generate --write-seeds`).
"""

DATASET_SHA256: dict[str, str] = {
    "full": "f120f245489ce016e39e08c21e5cadb2fd0aae32657a6e8a922e5994fa469872",
    "small": "c3b5c5d13175a1c22438bbd2ba4a85779dcf14a5f32ada3d33b5575414e1277d",
}
