cmake_minimum_required(VERSION 3.20)
project(whisper-service-worker LANGUAGES C CXX)

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

if(NOT DEFINED WHISPER_CPP_SOURCE_DIR)
  message(FATAL_ERROR "WHISPER_CPP_SOURCE_DIR must point to whisper.cpp v1.9.1")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_STATIC ON CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

add_subdirectory("${WHISPER_CPP_SOURCE_DIR}" whisper.cpp-build EXCLUDE_FROM_ALL)

add_executable(whisper-worker whisper-worker.cpp)
target_compile_features(whisper-worker PRIVATE cxx_std_17)
target_link_libraries(whisper-worker PRIVATE whisper)

if(MSVC)
  target_compile_options(whisper-worker PRIVATE /W4 /permissive- /EHsc)
else()
  target_compile_options(whisper-worker PRIVATE -Wall -Wextra -Wpedantic)
endif()

install(TARGETS whisper-worker RUNTIME DESTINATION .)
