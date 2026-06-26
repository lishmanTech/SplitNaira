extern crate alloc;
use alloc::string::String;

pub struct ContractArtifact {
    pub wasm_hash: String,
    pub code: String,
    pub version: u32,
}
