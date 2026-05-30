use crate::errors::err;
use crate::types::ContractArtifact;

pub fn validate_artifact(artifact: &ContractArtifact) -> Result<(), String> {
    if artifact.wasm_hash.len() == 0 {
        return Err(err("INVALID_WASM_HASH"));
    }

    if artifact.version == 0 {
        return Err(err("INVALID_VERSION"));
    }

    Ok(())
}