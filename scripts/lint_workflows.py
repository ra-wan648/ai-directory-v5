#!/usr/bin/env python3
"""Check every workflow's shell blocks as real bash, and its keys for duplicates.

Why this exists. On 14 Sep the "Warm the public cache" step lost its loop body
and its `done`. The file stayed perfectly valid YAML - a block scalar simply
ended early - so nothing complained, the run started, and bash died with
"syntax error: unexpected end of file". Because that step sits above the
taxonomy pass, both snapshot bakes, the junk cleanup, the scrapers and the LLM
fill, every one of those silently stopped running for eight nights while the
only visible symptom was a red X on a run nobody was watching.

`python -c "import yaml; yaml.safe_load(...)"` does not catch it. Running
`bash -n` over each block does, and that is all this does. It also rejects
duplicate mapping keys, which PyYAML normally accepts silently (a previous
incident here was caused by a duplicated `run:` key).

Run: python3 scripts/lint_workflows.py
"""
import glob
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:
    print("pyyaml is required: pip install pyyaml")
    sys.exit(2)


class Loader(yaml.SafeLoader):
    """SafeLoader that refuses duplicate keys instead of keeping the last one."""


def _no_duplicates(loader, node, deep=False):
    seen = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=True)
        if key in seen:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key: {key!r}", key_node.start_mark)
        seen.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep)


Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicates)


def main(paths=None):
    files = paths or sorted(glob.glob(".github/workflows/*.yml"))
    if not files:
        print("no workflow files found")
        return 1

    failures = 0
    blocks = 0
    for path in files:
        name = path.rsplit("/", 1)[-1]
        try:
            with open(path) as fh:
                doc = yaml.load(fh, Loader=Loader)
        except Exception as exc:  # noqa: BLE001 - report whatever PyYAML says
            print(f"  YAML  FAIL  {name}: {str(exc)[:120]}")
            failures += 1
            continue

        steps = [s for job in (doc.get("jobs") or {}).values()
                 for s in (job.get("steps") or [])]
        in_file = 0
        for step in steps:
            script = step.get("run")
            if not isinstance(script, str):
                continue
            blocks += 1
            in_file += 1
            with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as tmp:
                tmp.write(script + "\n")
                tmp_path = tmp.name
            result = subprocess.run(["bash", "-n", tmp_path],
                                    capture_output=True, text=True)
            if result.returncode != 0:
                first = result.stderr.strip().splitlines()
                print(f"  BASH  FAIL  {name} :: {step.get('name', '(unnamed)')}")
                print(f"        {first[0][:120] if first else 'unknown error'}")
                failures += 1

        print(f"  ok    {name:<18} steps={len(steps)} run-blocks={in_file}")

    print()
    if failures:
        print(f"{failures} problem(s) - a broken step here can silently skip the steps below it.")
        return 1
    print(f"all clean ({blocks} run block(s) checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or None))
