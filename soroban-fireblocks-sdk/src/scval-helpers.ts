import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

export function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

export function symbolToScVal(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: "symbol" });
}

export function addressVecToScVal(addresses: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(addresses.map(addressToScVal));
}

export function bytesN32ToScVal(hash: Buffer): xdr.ScVal {
  if (hash.length !== 32) {
    throw new Error(`bytesN32ToScVal: expected 32-byte buffer, got ${hash.length}`);
  }
  return xdr.ScVal.scvBytes(hash);
}
