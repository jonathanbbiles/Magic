function addUsdMicro(initialUsd, incrementsUsd) {
  const scale = 1_000_000n;
  let acc = BigInt(Math.round(Number(initialUsd) * Number(scale)));
  for (const inc of incrementsUsd || []) {
    acc += BigInt(Math.round(Number(inc) * Number(scale)));
  }
  return Number(acc) / Number(scale);
}

module.exports = { addUsdMicro };
