"""Compare all schema SQL; only known array cast deparsing and dump nonces differ."""
import re


def canonical(text, mappings):
    original = text.splitlines()
    controls = [line for line in original if line.startswith(("\\restrict", "\\unrestrict"))]
    assert len(controls) == 2
    opening = re.fullmatch(r"\\restrict ([A-Za-z0-9]+)", controls[0])
    closing = re.fullmatch(r"\\unrestrict ([A-Za-z0-9]+)", controls[1])
    assert opening and closing and opening[1] == closing[1], "dump nonce count/order/pair mismatch"
    lines = [line for line in original if line not in controls]
    for mapping in mappings:
        before, after = mapping["before"], mapping["after"]
        # Each exact constraint must occur once, in either serialization form.
        assert lines.count(before) + lines.count(after) == 1
        lines = [after if line == before else line for line in lines]
    return "\n".join(lines).strip()
