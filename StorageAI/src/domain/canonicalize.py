class CanonicalizeService:
    def canonicalize(self, name: str) -> str:
        norm = (name or "").strip().lower()
        return " ".join(norm.split())

    def normalize_for_match(self, text: str) -> str:
        base = self.canonicalize(text)
        tokens = base.split()
        norm_tokens = []
        for tok in tokens:
            if len(tok) > 4 and tok.endswith("ies"):
                tok = tok[:-3] + "y"
            elif len(tok) > 3 and tok.endswith("es"):
                tok = tok[:-2]
            elif len(tok) > 3 and tok.endswith("s"):
                tok = tok[:-1]
            norm_tokens.append(tok)
        return " ".join(norm_tokens)

    # New helpers for stronger normalization
    def _strip_leading_articles(self, text: str) -> str:
        t = (text or "").strip()
        lowers = t.lower()
        for art in ("a ", "an ", "the ", "some ", "any ", "another ", "additional ", "extra "):
            if lowers.startswith(art):
                return t[len(art):].strip()
        return t

    def _collapse_of_phrases(self, text: str) -> str:
        # e.g., "pieces of candy" -> "candy", "piece of candy" -> "candy", "bunch of X" -> "X"
        import re
        t = text.strip()
        m = re.match(r"^(?:\w+\s+)?(?:piece|pieces|bunch|pack|set)\s+of\s+(.+)$", t, flags=re.IGNORECASE)
        if m:
            return m.group(1).strip()
        return t

    def _singularize_token(self, token: str, original_token: str | None = None) -> str:
        # Preserve acronyms like "TVs" -> "TV"
        if original_token:
            if len(original_token) >= 2 and original_token[:-1].isupper() and original_token[-1].lower() == "s":
                return original_token[:-1]
        tok = token
        if len(tok) > 4 and tok.endswith("ies"):
            return tok[:-3] + "y"
        # common es plurals
        for suf in ("ses", "xes", "zes", "ches", "shes"):
            if tok.endswith(suf):
                return tok[:-2]  # remove 'es'
        if tok.endswith("s") and not tok.endswith("ss") and len(tok) > 3:
            return tok[:-1]
        return tok

    def normalize_to_singular(self, name: str) -> str:
        # Lowercase canonical form, collapse articles and of-phrases, singularize last noun
        base = self._strip_leading_articles(name)
        base = self._collapse_of_phrases(base)
        base = self.canonicalize(base)
        tokens = base.split()
        if not tokens:
            return base
        # Singularize the last token; keep earlier tokens as-is
        last_idx = len(tokens) - 1
        tokens[last_idx] = self._singularize_token(tokens[last_idx])
        return " ".join(tokens)

    def normalize_to_singular_display(self, name: str) -> str:
        # Produce a display-friendly singular form preserving acronyms casing when possible
        original_tokens = (name or "").strip().split()
        working = self._strip_leading_articles(name)
        working = self._collapse_of_phrases(working)
        base = self.canonicalize(working)
        tokens = base.split()
        if not tokens:
            return working.strip()
        # Singularize last token with acronym awareness
        last_idx = len(tokens) - 1
        orig_last = original_tokens[last_idx] if last_idx < len(original_tokens) else None
        tokens[last_idx] = self._singularize_token(tokens[last_idx], original_token=orig_last)
        # Preserve acronym casing for tokens where original was uppercase
        display_tokens = []
        for i, tok in enumerate(tokens):
            orig = original_tokens[i] if i < len(original_tokens) else tok
            if orig.isupper():
                display_tokens.append(tok.upper())
            else:
                display_tokens.append(tok)
        return " ".join(display_tokens)


__all__ = ["CanonicalizeService"]