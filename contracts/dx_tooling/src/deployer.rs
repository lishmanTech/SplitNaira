use crate::types::ContractArtifact;

pub fn deploy_contract(artifact: &ContractArtifact) -> Option<u64> {
    if artifact.wasm_hash.len() == 0 {
        return None;
    }

    // fake contract id generation (in real: Soroban deploy)
    Some(artifact.version as u64 + 1000)
}