import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { addressToScVal, i128ToScVal } from "../../src/scval-helpers";

describe("addressToScVal", () => {
  it("converts a G... public key to ScVal and round-trips back", () => {
    const kp = Keypair.random();
    const gAddress = kp.publicKey();

    const scVal = addressToScVal(gAddress);

    expect(scVal).toBeInstanceOf(xdr.ScVal);
    const decoded = Address.fromScVal(scVal).toString();
    expect(decoded).toBe(gAddress);
  });

  it("converts a C... contract ID to ScVal and round-trips back", () => {
    const contractId = "CCV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XK5LVOV2XMCW";

    const scVal = addressToScVal(contractId);

    expect(scVal).toBeInstanceOf(xdr.ScVal);
    const decoded = Address.fromScVal(scVal).toString();
    expect(decoded).toBe(contractId);
  });

  it("throws on invalid address input", () => {
    expect(() => addressToScVal("not-a-valid-address")).toThrow();
  });
});

describe("i128ToScVal", () => {
  it("converts 0n to ScVal", () => {
    const scVal = i128ToScVal(0n);

    expect(scVal).toBeInstanceOf(xdr.ScVal);
    expect(scVal.switch().name).toBe("scvI128");
  });

  it("converts a positive bigint to ScVal", () => {
    const scVal = i128ToScVal(1_000_000_000n);

    expect(scVal).toBeInstanceOf(xdr.ScVal);
    expect(scVal.switch().name).toBe("scvI128");
  });

  it("converts a large bigint (> 2^64) to ScVal", () => {
    const large = 2n ** 100n;
    const scVal = i128ToScVal(large);

    expect(scVal).toBeInstanceOf(xdr.ScVal);
    expect(scVal.switch().name).toBe("scvI128");
  });

  it("round-trips through XDR serialization", () => {
    const amount = 42_000_000_000n;
    const scVal = i128ToScVal(amount);

    // Serialize to XDR and back
    const xdrBytes = scVal.toXDR();
    const restored = xdr.ScVal.fromXDR(xdrBytes);

    expect(restored.switch().name).toBe("scvI128");
    expect(restored.toXDR("base64")).toBe(scVal.toXDR("base64"));
  });
});
