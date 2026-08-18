// Inert replacement for koffi on iOS. DSH only consumes koffi in Win32 code.
function unavailable(name) {
  return function koffiUnavailable() {
    throw new Error(
      `koffi.${name}() is unavailable on iOS; this Win32 code path must not run`,
    );
  };
}

const stub = {
  pointer(spec) {
    return { __koffiType: "pointer", spec };
  },
  struct(name, members) {
    return { __koffiType: "struct", name, members };
  },
  load: unavailable("load"),
  register: unavailable("register"),
  call: unavailable("call"),
  alloc: unavailable("alloc"),
  encode: unavailable("encode"),
  decode: unavailable("decode"),
  address: unavailable("address"),
  alias: unavailable("alias"),
  array: unavailable("array"),
  as: unavailable("as"),
  config: unavailable("config"),
  disposable: unavailable("disposable"),
  enumeration: unavailable("enumeration"),
  opaque: unavailable("opaque"),
  pack: unavailable("pack"),
  proto: unavailable("proto"),
  sizeof: unavailable("sizeof"),
  alignof: unavailable("alignof"),
  offsetof: unavailable("offsetof"),
  type: unavailable("type"),
  introspect: unavailable("introspect"),
  resolve: unavailable("resolve"),
  unpack: unavailable("unpack"),
  errno: unavailable("errno"),
};

export default stub;
