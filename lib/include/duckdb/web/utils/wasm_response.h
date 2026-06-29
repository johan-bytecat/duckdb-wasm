#ifndef INCLUDE_DUCKDB_WEB_UTILS_WASM_RESPONSE_H_
#define INCLUDE_DUCKDB_WEB_UTILS_WASM_RESPONSE_H_

#include <cstdint>

#include "arrow/io/buffered.h"
#include "arrow/io/interfaces.h"
#include "arrow/ipc/writer.h"

namespace duckdb {
namespace web {

struct DuckDBWasmResultsWrapper;

/// Packed response buffer (24 bytes) read by JavaScript via HEAPF64 (WASM32) or HEAP64 (WASM64).
/// Under WASM32, doubles can losslessly represent all 32-bit pointer values.
/// Under WASM64, int64_t fields are required to store full 64-bit addresses.
struct WASMResponse {
    /// The status code
#ifdef WASM_MEMORY64
    int64_t statusCode = 1;
#else
    double statusCode = 1;
#endif
    /// The data ptr or value (if any)
#ifdef WASM_MEMORY64
    int64_t dataOrValue = 0;
#else
    double dataOrValue = 0;
#endif
    /// The data size
#ifdef WASM_MEMORY64
    int64_t dataSize = 0;
#else
    double dataSize = 0;
#endif
} __attribute((packed));

class WASMResponseBuffer {
   protected:
    /// The status message
    std::string status_message_;
    /// The string result buffer (if any)
    std::string result_str_;
    /// The arrow result buffer (if any)
    std::shared_ptr<arrow::Buffer> result_arrow_;

   public:
    /// Constructor
    WASMResponseBuffer();

    /// Clear the response buffer
    void Clear();
    /// Store the arrow status.
    /// Returns wheather the result was OK
    bool Store(WASMResponse& response, arrow::Status status);
    /// Store a DuckDBWasmResultsWrapper
    void Store(WASMResponse& response, DuckDBWasmResultsWrapper& value);
    /// Store a string
    void Store(WASMResponse& response, std::string value);
    /// Store a string view
    void Store(WASMResponse& response, std::string_view value);
    /// Store the result buffer
    void Store(WASMResponse& response, arrow::Result<std::shared_ptr<arrow::Buffer>> result);
    /// Store the result string
    void Store(WASMResponse& response, arrow::Result<std::string> result);
    /// Store the result double
    void Store(WASMResponse& response, arrow::Result<double> result);
    /// Store the result size_t
    void Store(WASMResponse& response, arrow::Result<size_t> result);

    /// Get the instance
    static WASMResponseBuffer& Get();
};

}  // namespace web
}  // namespace duckdb

#endif  // INCLUDE_DUCKDB_WEB_WASM_RESPONSE_H_
