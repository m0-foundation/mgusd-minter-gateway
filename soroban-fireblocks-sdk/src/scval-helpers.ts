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

export function addressVecToScVal(addresses: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(addresses.map(addressToScVal));
}
