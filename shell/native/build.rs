fn main() {
    #[cfg(windows)]
    {
        embed_resource::compile("pluck.rc", embed_resource::NONE)
            .manifest_optional()
            .unwrap();
    }
    println!("cargo:rerun-if-changed=pluck.rc");
    println!("cargo:rerun-if-changed=Pluck.ico");
}
