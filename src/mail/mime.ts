export function decodeHeaderWords(value: string): string {
	const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
	return joined.replace(
		/=\?([^?\s]+)\?([bqBQ])\?([^?]*)\?=/g,
		(match, charset: string, encoding: string, text: string) => {
			try {
				const bytes =
					encoding.toUpperCase() === "B"
						? decodeBase64Bytes(text)
						: decodeQEncodedBytes(text);
				return decodeBytes(bytes, charset);
			} catch {
				return match;
			}
		},
	);
}

function decodeBase64Bytes(value: string): Uint8Array {
	const binary = atob(value.replace(/\s+/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function decodeQEncodedBytes(value: string): Uint8Array {
	const bytes: number[] = [];
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character === "_") {
			bytes.push(0x20);
			continue;
		}
		if (character === "=" && isHex(value[index + 1]) && isHex(value[index + 2])) {
			bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
			index += 2;
			continue;
		}
		bytes.push(character.charCodeAt(0));
	}
	return new Uint8Array(bytes);
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
	const label = charset.trim().toLowerCase() === "utf8" ? "utf-8" : charset.trim();
	try {
		return new TextDecoder(label).decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

function isHex(value: string | undefined): boolean {
	return value !== undefined && /^[\da-f]$/i.test(value);
}
