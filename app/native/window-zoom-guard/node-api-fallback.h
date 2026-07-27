#pragma once

#include <cstddef>

extern "C" {

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

int napi_throw_error(napi_env env, const char* code, const char* message);
int napi_get_cb_info(napi_env env,
                     napi_callback_info info,
                     std::size_t* argc,
                     napi_value* argv,
                     napi_value* thisArg,
                     void** data);
int napi_get_buffer_info(napi_env env,
                         napi_value value,
                         void** data,
                         std::size_t* length);
int napi_get_boolean(napi_env env, bool value, napi_value* result);
int napi_create_function(napi_env env,
                         const char* utf8name,
                         std::size_t length,
                         napi_callback cb,
                         void* data,
                         napi_value* result);
int napi_set_named_property(napi_env env,
                            napi_value object,
                            const char* utf8name,
                            napi_value value);

}  // extern "C"

#define NAPI_AUTO_LENGTH SIZE_MAX
